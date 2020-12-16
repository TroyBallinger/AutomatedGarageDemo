# LicensePlateServer

A simple Node server to listen for activity on a Raspberry Pi's camera. If activity is detected, a picture will be snapped and sent to OpenALPR for analysis.
Then, if the image can be recognized as a car with a readable license plate, the probable plate ID is checked against a Firebase database of known, trusted cars input by the user via the accompanying Android app (not in this codebase).
The door will then open automatically for trusted cars, remain closed for untrusted cars, and prompt the user to deny or accept an unrecognized car upon its arrival in front of the camera. If the user accepts via the Android app, the door will open.

This server was originally designed to support HTTP requests directly, but due to time constraints and security concerns, I refactored the code to have the server only communicate between OpenALPR's API and Firebase with no possible input from the outside world except when the camera is triggered.

Replicating my setup is largely infeasible, however, this code will be posted as a reference for anyone attempting something similar with a modified version of my code.

## Prerequisites
This server is intended to run on a Raspberry Pi and depends on PiGPIO, Node, and npm to run properly.
### Step 1:
Install pigpio (Note: This will not work on most common, non-Pi Linux distros)

`sudo apt-get update && sudo apt-get install pigpio`

### Step 2:
Install Node/npm
`sudo apt-get install nodejs`

(Optional/Recommended) Install Node using nvm

### Step 3: 
Ensure proper installations:

`node -v`

`npm -v`

`pigpiod -v`

## Getting started

### Step 1:
Download and install required node_modules

`npm install`

### Step 2:
Start the server

`npm start`

or

`sudo node app.js`

### Step 3:
You're all set! You can shut down the server using:

`npm stop`

[Warning] This command is for dev purposes and will kill any running node instance, even other servers

