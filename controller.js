const fs = require('fs');
var request = require('request');
const secrets = require('./creds/secrets.json');
var admin = require('firebase-admin');

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://licenseplatesensor-10da0.firebaseio.com"
});

var database = admin.database();

// Setup camera
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
		sendPicture().catch((error) => {
			console.log("ERROR: OpenALPR", error);
		});
	}
};

async function sendPicture() {
	var bitmap = fs.readFileSync('latest.jpg');
	var base64string = new Buffer(bitmap).toString('base64');
	var uploader = require('base64-image-upload');
	var plate = undefined;
	if (process.env.OPEN_ALPR) {
		await request.post({url: url, 
			body: JSON.stringify(base64string)}, 
			(err, httpResponse, body) => {
				if (err) {
					console.log('upload failed:', err);
					return;
				}
				if (!body) {
					return;
				}
				const results = JSON.parse(body).results;
				if (results > 0) {
					plate = results[0]['plate'];	
				} else {
					console.log('No results');
				}
		});
		console.log('Upload complete!');
		if (!plate) {
			console.log('No plate found');
			return;
		}
	}
	var plate_array = [];
	console.log('Plate:', plate);
	var ref = database.ref("plates");
	//ref.push({"plate": "testplate"});
	await ref.orderByChild("plate").once("value", function(snapshot) {
		//console.log(snapshot.val());
		snapshot.forEach(function(data) {
			//console.log(data.key + ": " + data.val()['plate']);
			plate_array.push(data.val()['plate']);
		});
	}, function (errorObject) {
		console.log("ERROR: Firebase" + errorObject.code);
	});
	console.log('Found plates: ', plate_array);
	var found = plate_array.find((plateFound) => {
		return plateFound === plate;
	});
	if (found) {
		console.log('Plate match!');
	} else {
		console.log('Plate not found in database');
	}
}