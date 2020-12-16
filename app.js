// Bring in env variables
require('dotenv').config();

const process = require('process');
const controller = require('./controller.js');

// Setup motion sensor
const gpio = require('onoff').Gpio;
const pir = new gpio(4, 'in', 'both');

// Init servo
controller.initializeServo();

// Watch for motion
pir.watch(async (err, value) => {
	if (err) {
		console.log("ERROR: Motion detector");
	} else if (value == 1) { 
		// Motion detected
		await controller.sendPicToCloud();
	} else {
		// No motion
	}
});

console.log(`LicensePlateServer started successfully.`);

process.on('exit', (code) => {
	console.log(`LicensePlateServer exited with code ${code}.`);
});