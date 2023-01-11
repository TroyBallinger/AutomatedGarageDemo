// Bring in env variables
require("dotenv").config();

import process from "process";
import { Gpio } from "onoff";

import { initializeServo, sendPicToCloud } from "./controller.js";

// Setup motion sensor
const pir = new Gpio(4, "in", "both");

// Init servo
initializeServo();

// Watch for motion
pir.watch(async (err, value) => {
  if (err) {
    console.log("ERROR: Motion detector");
  } else if (value == 1) {
    // Motion detected
    await sendPicToCloud();
  } else {
    // No motion
  }
});

console.log("LicensePlateServer started successfully.");

process.on("exit", (code) => {
  console.log(`LicensePlateServer exited with code ${code}.`);
});
