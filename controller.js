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
const SECONDS_OPEN = 6;

// Configure camera
const PiCamera = require('pi-camera');
const myCamera = new PiCamera({
	mode: 'photo',
	output: `latest.jpg`,
	width: 640,
	height: 480,
	nopreview: true,
});

// Setup openALPR request
var url = "https://api.openalpr.com/v2/recognize_bytes?recognize_vehicle=1&country=us&secret_key=" + secrets.openalpr_key;;

// To check if door is already being opened
var busy = false;

module.exports = {
	async sendPicToCloud() {
		console.log("Motion detected, taking picture...");
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
	async openDoor() {
		tryOpenDoor();
	}
};

async function sendPicture() {
	var bitmap = fs.readFileSync('latest.jpg');
	var base64string = new Buffer(bitmap).toString('base64');
	var uploader = require('base64-image-upload');
	var car = undefined;
	if (process.env.OPEN_ALPR) {
		request.post({url: url, 
			body: JSON.stringify(base64string)}, 
			(err, httpResponse, body) => {
				if (err) {
					console.log('upload failed:', err);
					return;
				}
				if (!body) {
					return;
				}
				console.log('Upload complete!');
				const results = JSON.parse(body).results;
				if (results && results.length > 0) {
					// Take first result (highest confidence)
					car = {"plate": results[0]['plate']}
					try {
						car['color'] = results[0]['vehicle']['color'][0]['name'];
						car['make'] = results[0]['vehicle']['make'][0]['name'];
						car['model'] = results[0]['vehicle']['make_model'][0]['name'];
					} catch (error) {
						console.log("Error parsing OpenALPR", error.message)
					}
					console.log("Got car object: ", car);
				} else {
					console.log('No results from OpenALPR');
				}
				processResults(car);
		});
	} else {
		console.log('OpenALPR disabled, aborting.');
	}
}

async function processResults(car) {
	if (car === undefined) {
		console.log('No car detected');
		return;
	}
	var known_cars_array = [];
	console.log('Plate:', car['plate']);
	var ref = database.ref("Member");
	//ref.push({"plate": "T636696C"}); // test
	await ref.once("value", function(snapshot) {
		snapshot.forEach(function(data) {
			known_cars_array.push(data.val());
		});
	}, function (errorObject) {
		console.log("ERROR: Firebase" + errorObject.code);
	});
	var found = known_cars_array.find((knownCar) => {
		return knownCar['plate'] === car['plate'];
	});
	if (found) {
		console.log('Plate match! ' + JSON.stringify(found));
		tryOpenDoor();
	} else {
		console.log('No match!');
		var unknown_ref = database.ref("LoadImage");
		var pending_cars = []
		await unknown_ref.once("value", function(snapshot) {
			snapshot.forEach(function(data) {
				pending_cars.push(data.val());
			});
		}, function (errorObject) {
			console.log("ERROR: Firebase" + errorObject.code);
		});
		var alreadyUploaded = pending_cars.find((pendingCar) => {
			return pendingCar['plate'] === car['plate'];
		});
		if (!alreadyUploaded) {
			try {
				bucket.upload('latest.jpg', { destination: car['plate'] });
			} catch (error) {
				console.log('Failed image upload, aborting.');
				return;
			}
			unknown_ref.push(car);
			console.log('Uploaded unrecognized car info!');
		} else {
			console.log('Unrecognized car already uploaded.');
		}
	}
}

async function tryOpenDoor() {
	console.log("openDoor() called!");
	if (busy) {
		console.log("Already busy, aborting.");
		return;
	}
	busy = true;
	setTimeout(() => { closeDoor() }, SECONDS_OPEN * 1000);
}

async function closeDoor() {
	console.log("closeDoor() called!");
	busy = false;
}