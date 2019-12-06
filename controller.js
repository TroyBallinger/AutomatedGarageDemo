const fs = require('fs');
var request = require('request');
const secrets = require('./creds/secrets.json');
var admin = require('firebase-admin');

// Firebase init
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://licenseplatesensor-10da0.firebaseio.com",
  storageBucket: "licenseplatesensor-10da0.appspot.com"
});

// Setup database and storage
const database = admin.database();
const bucket = admin.storage().bucket();

// Time to keep the door open in seconds
const SECONDS_OPEN = 10;

// Configure camera
const PiCamera = require('pi-camera');
const myCamera = new PiCamera({
	mode: 'photo',
	output: `latest.jpg`,
	width: 640,
	height: 480,
	nopreview: true,
});

// Configure servo
const s_gpio = require('pigpio').Gpio;
const motor = new s_gpio(3, {mode: s_gpio.OUTPUT});
const CLOSED_PW = 1500;
const OPEN_PW = 850;
let increment = 50;
let current_pw;

// Handle interupts gracefully
process.on('SIGINT', () => {
	motor.servoWrite(0);
	process.exit(0);
});

// Setup openALPR request
var url = "https://api.openalpr.com/v2/recognize_bytes?recognize_vehicle=1&country=us&secret_key=" + secrets.openalpr_key;;

// To check if door is already being opened
var door_busy = false;
var door_open = false;
var processing_image = false;

// Actively look for acceptance of new cars into db
var ref = database.ref("LoadImage");
ref.on("child_removed", function(snapshot) {
	console.log(JSON.stringify(snapshot));
	tryOpenDoor();
}, function (errorObject) {
	console.log("ERROR: Firebase (update) " + errorObject.code);
});

module.exports = {
	async sendPicToCloud() {
		if (processing_image) return;
		console.log("Motion detected, taking picture...");
		processing_image = true;
		await myCamera.snap()
		.then(async (result) => {
			console.log("Taken!");
		})
		.catch((error) => {
			console.log("ERROR: Camera", error);
		});
		// Successfully taken, carry on to sending picture
		sendPicture().catch((error) => {
			console.log("ERROR: OpenALPR", error);
		});
	},
	async initializeServo() {
		motor.servoWrite(CLOSED_PW);
		current_pw = CLOSED_PW;
		setTimeout(() => { motor.servoWrite(0) }, 3000);
	}
};

async function sendPicture() {
	var bitmap = fs.readFileSync('latest.jpg');
	var base64string = new Buffer(bitmap).toString('base64');
	var cars = undefined;
	if (process.env.OPEN_ALPR) {
		request.post({url: url, 
			body: JSON.stringify(base64string)}, 
			async (err, httpResponse, body) => {
				if (err) {
					console.log('upload failed:', err);
					processing_image = false;
					return;
				}
				if (!body) {
					processing_image = false;
					return;
				}
				console.log('Upload complete!');
				const results = JSON.parse(body).results;
				if (results && results.length > 0 && results[0]['candidates'].length > 0) {
					cars = [];
					results[0]['candidates'].forEach(car => {
						if (car['confidence'] > 75) {
							console.log(car);
							var carEntry = {};
							carEntry['plate'] = car['plate'];
							carEntry['color'] = results[0]['vehicle']['color'][0]['name'];
							carEntry['make'] = results[0]['vehicle']['make'][0]['name'];
							carEntry['model'] = results[0]['vehicle']['make_model'][0]['name'];
							cars.push(carEntry);
						}
					});
				} else {
					console.log('No results from OpenALPR');
				}
				await processResults(cars);
		});
	} else {
		console.log('OpenALPR disabled, aborting.');
		processing_image = false;
	}
}

async function processResults(cars) {
	if (cars === undefined || cars.length == 0) {
		console.log('No car detected');
		processing_image = false;
		return;
	}
	var known_cars_array = [];
	console.log('Possibilities:', cars);
	var ref = database.ref("Member");
	await ref.once("value", function(snapshot) {
		snapshot.forEach(function(data) {
			known_cars_array.push(data.val());
		});
	}, function (errorObject) {
		console.log("ERROR: Firebase" + errorObject.code);
	});
	var found = known_cars_array.find((knownCar) => {
		return cars.find((carGuess) => {
			return knownCar['plate'] === carGuess['plate'];
		});
	});
	if (found) {
		console.log('Plate match! ' + JSON.stringify(found));
		await tryOpenDoor();
	} else {
		console.log('No match!');
		var unknown_ref = database.ref("LoadImage");
		var pending_cars = [];
		await unknown_ref.once("value", function(snapshot) {
			snapshot.forEach(function(data) {
				pending_cars.push(data.val());
			});
		}, function (errorObject) {
			console.log("ERROR: Firebase" + errorObject.code);
		});
		var alreadyUploaded = pending_cars.find((pendingCar) => {
			return pendingCar['plate'] === cars[0]['plate'];
		});
		if (!alreadyUploaded) {
			try {
				bucket.upload('latest.jpg', { destination: cars[0]['plate'] });
			} catch (error) {
				console.log('Failed image upload, aborting.');
				processing_image = false;
				return;
			}
			unknown_ref.push(cars[0]);
			console.log('Uploaded unrecognized car info!');
		} else {
			console.log('Unrecognized car already uploaded.');
		}
		processing_image = false;
	}
}

async function tryOpenDoor() {
	console.log("Opening door...");
	if (door_busy || door_open) {
		console.log("Already busy or open, aborting.");
		return;
	}
	door_busy = true;
	var openFunction = setInterval(moveServo, 100);
	function stopFunction() {
		clearInterval(openFunction);
		motor.servoWrite(0);
		door_open = true;
		door_busy = false;
		console.log("Open!");
	}
	function moveServo() {
		if (current_pw >= OPEN_PW) {
			motor.servoWrite(current_pw);
			current_pw -= increment;
		} else {
			current_pw = OPEN_PW;
			stopFunction();
		}
	}
	await new Promise(() => setTimeout(() => { closeDoor() }, SECONDS_OPEN * 1000));
}



async function closeDoor() {
	console.log("Closing door...");
	if (door_busy || !door_open) {
		console.log("Already busy or closed, aborting.");
		return;
	}
	door_busy = true;
	var closeFunction = setInterval(moveServo, 100);
	function stopFunction() {
		clearInterval(closeFunction);
		motor.servoWrite(0);
		door_open = false;
		door_busy = false;
		console.log("Closed!");
		processing_image = false;
	}
	function moveServo() {
		if (current_pw <= CLOSED_PW) {
			motor.servoWrite(current_pw);
			current_pw += increment;
		} else {
			current_pw = CLOSED_PW;
			stopFunction();
		}
	}
}