const fs = require('fs');
const request = require('request');
const secrets = require('./creds/secrets.json');
const admin = require('firebase-admin');
const PiCamera = require('pi-camera');

// Time to keep the door open in seconds
const SECONDS_OPEN = 10;

// Configure servo
const s_gpio = require('pigpio').Gpio;
const motor = new s_gpio(3, {mode: s_gpio.OUTPUT});
const CLOSED_PW = 1500;
const OPEN_PW = 850;
let increment = 50;
let current_pw;

// Firebase init
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://licenseplatesensor-10da0.firebaseio.com",
  storageBucket: "licenseplatesensor-10da0.appspot.com"
});

// Setup database and storage
const database = admin.database();
const bucket = admin.storage().bucket();

// Configure camera
const myCamera = new PiCamera({
	mode: 'photo',
	output: `latest.jpg`,
	width: 640,
	height: 480,
	nopreview: true,
});

// Handle interupts gracefully
process.on('SIGINT', () => {
	motor.servoWrite(0);
	process.exit(0);
});

// To check if door is already being opened
var door_busy = false;
var door_open = false;
var processing_image = false;

// Actively look for acceptance of new cars into db, aka deletion from pending requests queue
var ref = database.ref("LoadImage");
ref.on("child_removed", function(snapshot) {
	console.log(JSON.stringify(snapshot));
	tryOpenDoor();
}, function (errorObject) {
	console.log("ERROR: Firebase (update) " + errorObject.code);
});

// Setup openALPR request
var url = "https://api.openalpr.com/v2/recognize_bytes?recognize_vehicle=1&country=us&secret_key=" + secrets.openalpr_key;

/**
 *  Attempt to send a recently taken picture to be analyzed by OpenALPR via their API 
 *  @returns void
 */ 
async function sendPicture() {
	// Convert image to base64 for http request
	var bitmap = fs.readFileSync('latest.jpg');
	var base64string = new Buffer(bitmap).toString('base64');
	var cars = undefined;
	if (process.env.OPEN_ALPR) {
		request.post({url: url, 
			body: JSON.stringify(base64string)}, 
			async (err, _httpResponse, body) => {
				if (err) {
					// Failure with error
					console.log('upload failed:', err);
					processing_image = false;
					return;
				}
				if (!body) {
					// Failure without error
					processing_image = false;
					return;
				}
				console.log('Upload complete!');
				const results = JSON.parse(body).results;
				// If OpenALPR has potential matches
				if (results && results.length > 0 && results[0]['candidates'].length > 0) {
					cars = [];
					// Find those with 75% or greater confidence
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

/**
 *  Attempt to find matches in database for cars identified by OpenALPR results
 *  @param cars: A list of potential car objects as outlined in OpenALPR API
 *  @returns void
 */ 
async function processResults(cars) {
	if (cars === undefined || cars.length == 0) {
		console.log('No car detected');
		processing_image = false;
		return;
	}

	var known_cars_array = [];
	console.log('Possibilities:', cars);
	var ref = database.ref("Member");

	// Pull all recognized cars from Firebase
	await ref.once("value", function(snapshot) {
		snapshot.forEach(function(data) {
			known_cars_array.push(data.val());
		});
	}, function (errorObject) {
		console.log("ERROR: Firebase" + errorObject.code);
	});

	// Compare OpenALPR results against Firebase entries
	var found = known_cars_array.find((knownCar) => {
		return cars.find((carGuess) => {
			return knownCar['plate'] === carGuess['plate'];
		});
	});

	// Check for car match
	if (found) {
		console.log('Plate match! ' + JSON.stringify(found));
		await tryOpenDoor();
	} else {
		console.log('No match!');

		var unknown_ref = database.ref("LoadImage");
		var pending_cars = [];

		// Push unknown car license plate to Firebase
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
			// Upload image of unrecognized car to Firebase database
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
		// NOTE: Listeners for image uploads will trigger the Android app to notify user
		// of unrecognized vehicle and allow he/she to open gate from the app by hitting
		// the webserver with a valid put request

		processing_image = false;
	}
}

/**
 *  Attempts to open the garage door, if it is not being opened or already open
 *  @returns void
 */ 
async function tryOpenDoor() {
	console.log("Opening door...");

	if (door_busy || door_open) {
		console.log("Already busy or open, aborting.");
		return;
	}

	door_busy = true;
	var openFunction = setInterval(moveServo, 100);

	// Inject a function to stop opening the door and reset variables when "open"
	function stopFunction() {
		clearInterval(openFunction);
		motor.servoWrite(0);
		door_open = true;
		door_busy = false;
		console.log("Open!");
	}

	// Injected function to incrementally move servo until "open" threshold is reached
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

/**
 *  Attempts to close the garage door, if it is not closing or already closed
 *  @returns void
 */ 
async function closeDoor() {
	console.log("Closing door...");

	if (door_busy || !door_open) {
		console.log("Already busy or closed, aborting.");
		return;
	}

	door_busy = true;
	var closeFunction = setInterval(moveServo, 100);

	// Stop closing
	function stopFunction() {
		clearInterval(closeFunction);
		motor.servoWrite(0);
		door_open = false;
		door_busy = false;
		console.log("Closed!");
		processing_image = false;
	}

	// Repeat servo move until closed
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

module.exports = {
	/**
	 *  Allows the main app to send the most recently taken picture to ALPR and start open logic
	 *  @returns void
	 */ 
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
	/**
	 *  Reset servo position on server start
	 *  @returns void
	 */ 
	async initializeServo() {
		motor.servoWrite(CLOSED_PW);
		current_pw = CLOSED_PW;
		setTimeout(() => { motor.servoWrite(0) }, 3000);
	}
};