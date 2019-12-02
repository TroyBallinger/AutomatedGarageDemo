// Bring in env variables
require('dotenv').config();

var express = require('express');
var bodyParser = require('body-parser');
var app = express();
var controller = require('./controller.js');

// Enables us to parse JSON
app.use(bodyParser.json());

// Use public html webpage (for testing)
app.use('/', express.static('public'));

// Use routes
//app.use('/', require('./routes.js'));

// Define server
var server = require('http').Server(app);

// Setup motion sensor
var gpio = require('onoff').Gpio;
var pir = new gpio(4, 'in', 'both');

// Init servo
controller.initializeServo();

// Watch for motion
pir.watch(async (err, value) => {
	if (err) {
		console.log("ERROR: Motion detector");
	} else if (value == 1) { // Motion detected
		await controller.sendPicToCloud();
	} else {
		// No motion
	}
});

var port = 8000;

// Listen on port
server.listen(port);

// Sanity check
console.log('Server running on port ' + port);