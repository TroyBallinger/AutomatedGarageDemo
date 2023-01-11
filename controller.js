import axios from "axios";
import admin from "firebase-admin";
import fs from "fs";
import PiCamera from "pi-camera";
import { Gpio } from "pigpio";

import { createRequire } from "module";
const require = createRequire(import.meta.url);
const secrets = require("./creds/secrets.json");

if (
  !secrets ||
  !secrets.database_url ||
  !secrets.storage_bucket ||
  !secrets.openalpr_key
) {
  console.error("Missing secrets.");
  process.exit();
}

// Firebase init
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: secrets.database_url,
  storageBucket: secrets.storage_bucket,
});

// Time to keep the door open in seconds
const SECONDS_OPEN = 10;
const MIN_OPENALPR_CAR_CONFIDENCE = 75;

// Configure servo
const motor = new Gpio(3, { mode: Gpio.OUTPUT });
const CLOSED_PW = 1500;
const OPEN_PW = 850;
let increment = 50;
let current_pw;

// Setup database and storage
const database = admin.database();
const bucket = admin.storage().bucket();

// Configure camera
const myCamera = new PiCamera({
  mode: "photo",
  output: `latest.jpg`,
  width: 640,
  height: 480,
  nopreview: true,
});

// Handle interupts gracefully
process.on("SIGINT", () => {
  motor.servoWrite(0);
  process.exit(0);
});

// To check if door is already being opened
let door_busy = false;
let door_open = false;
let processing_image = false;

// Deletion from pending requests queue = acceptance of a new car
const ref = database.ref("LoadImage");
ref.on(
  "child_removed",
  (snapshot) => {
    console.log(JSON.stringify(snapshot));
    tryOpenDoor();
  },
  (error) => {
    console.error("ERROR: Firebase", error.code);
  }
);

// Setup openALPR request
const url = `https://api.openalpr.com/v2/recognize_bytes?recognize_vehicle=1&country=us&secret_key=${secrets.openalpr_key}`;

/**
 *  Attempt to send a recently taken picture to be analyzed by OpenALPR via their API
 */
const sendPicture = async () => {
  // Convert image to base64 for http request
  const bitmap = fs.readFileSync("latest.jpg");
  const base64string = Buffer.from(bitmap).toString("base64");
  let cars = undefined;

  if (!process.env.OPEN_ALPR) {
    console.error("OpenALPR disabled.");

    processing_image = false;
    return;
  }

  axios
    .post(url, JSON.stringify(base64string))
    .then(async (response) => {
      if (!body) {
        processing_image = false;
        return;
      }
      console.log("Upload complete!");

      const results = JSON.parse(response.body).results;
      // If OpenALPR has potential matches
      if (
        results &&
        results.length > 0 &&
        results[0]["candidates"].length > 0
      ) {
        cars = [];

        results[0]["candidates"].forEach((car) => {
          if (car["confidence"] >= MIN_OPENALPR_CAR_CONFIDENCE) {
            console.log("Adding:", car);

            let carEntry = {};
            carEntry["plate"] = car["plate"];
            carEntry["color"] = results[0]["vehicle"]["color"][0]["name"];
            carEntry["make"] = results[0]["vehicle"]["make"][0]["name"];
            carEntry["model"] = results[0]["vehicle"]["make_model"][0]["name"];
            cars.push(carEntry);
          }
        });
      } else {
        console.log("No results from OpenALPR");
      }

      await processResults(cars);
    })
    .catch((err) => {
      console.error("Upload failed:", err);
      processing_image = false;
    });
};

/**
 *  Attempt to find matches in database for cars identified by OpenALPR results
 *  @param cars: A list of potential car objects as outlined in OpenALPR API
 */
const processResults = async (cars) => {
  if (!cars || cars.length === 0) {
    console.log("No car detected");

    processing_image = false;
    return;
  }
  console.log("Possibilities:", cars);

  let known_cars_array = [];

  const ref = database.ref("Member");

  // Pull all recognized cars from Firebase
  await ref.once(
    "value",
    (snapshot) => {
      snapshot.forEach((data) => {
        known_cars_array.push(data.val());
      });
    },
    (errorObject) => {
      console.error("ERROR: Firebase" + errorObject.code);
    }
  );

  // Compare OpenALPR results against Firebase entries
  const found = known_cars_array.find((knownCar) =>
    cars.find((carGuess) => knownCar["plate"] === carGuess["plate"])
  );

  // Check for car match
  if (found) {
    console.log("Plate match:", JSON.stringify(found));

    await tryOpenDoor();
  } else {
    console.log("No match!");

    const unknown_ref = database.ref("LoadImage");
    let pending_cars = [];

    // Push unknown car license plate to Firebase
    await unknown_ref.once(
      "value",
      (snapshot) => {
        snapshot.forEach((data) => {
          pending_cars.push(data.val());
        });
      },
      (errorObject) => {
        console.error("ERROR: Firebase", errorObject.code);
      }
    );

    const alreadyUploaded = pending_cars.find(
      (pendingCar) => pendingCar["plate"] === cars[0]["plate"]
    );

    if (!alreadyUploaded) {
      // Upload image of unrecognized car to Firebase database
      try {
        bucket.upload("latest.jpg", { destination: cars[0]["plate"] });
      } catch (_error) {
        console.error("Failed image upload.");

        processing_image = false;
        return;
      }

      unknown_ref.push(cars[0]);
      console.log("Uploaded unrecognized car info!");
    } else {
      console.log("Unrecognized car already uploaded.");
    }
    // NOTE: Listeners for image uploads will trigger the Android app to notify user
    // of unrecognized vehicle and allow he/she to open gate from the app by hitting
    // the webserver with a valid put request

    processing_image = false;
  }
};

/**
 *  Attempts to open the garage door, if it is not being opened or already open
 */
const tryOpenDoor = async () => {
  console.log("Opening door...");

  if (door_busy || door_open) {
    console.error("Door already busy or open.");
    return;
  }

  door_busy = true;
  const openFunction = setInterval(moveServo, 100);

  const stopFunction = () => {
    clearInterval(openFunction);
    motor.servoWrite(0);
    door_open = true;
    door_busy = false;
    console.log("Open!");
  };

  const moveServo = () => {
    if (current_pw >= OPEN_PW) {
      motor.servoWrite(current_pw);
      current_pw -= increment;
    } else {
      current_pw = OPEN_PW;
      stopFunction();
    }
  };

  await new Promise(() =>
    setTimeout(() => {
      closeDoor();
    }, SECONDS_OPEN * 1000)
  );
};

/**
 *  Attempts to close the garage door, if it is not closing or already closed
 */
const closeDoor = async () => {
  console.log("Closing door...");

  if (door_busy || !door_open) {
    console.error("Door already busy or closed.");
    return;
  }

  door_busy = true;
  const closeFunction = setInterval(moveServo, 100);

  const stopFunction = () => {
    clearInterval(closeFunction);
    motor.servoWrite(0);
    door_open = false;
    door_busy = false;
    console.log("Closed!");
    processing_image = false;
  };

  // Repeat servo move until closed
  const moveServo = () => {
    if (current_pw <= CLOSED_PW) {
      motor.servoWrite(current_pw);
      current_pw += increment;
    } else {
      current_pw = CLOSED_PW;
      stopFunction();
    }
  };
};

/**
 *  Allows the main app to send the most recently taken picture to ALPR and start open logic
 */
const sendPicToCloud = async () => {
  if (processing_image) return;
  console.log("Taking picture...");

  processing_image = true;
  await myCamera
    .snap()
    .then(async (_result) => {
      console.log("Taken!");
    })
    .catch((error) => {
      console.error("ERROR: Camera", error);
    });
  // Successfully taken, carry on to sending picture
  sendPicture().catch((error) => {
    console.error("ERROR: OpenALPR", error);
  });
};

/**
 *  Reset servo position on server start
 */
const initializeServo = async () => {
  motor.servoWrite(CLOSED_PW);
  current_pw = CLOSED_PW;
  setTimeout(() => {
    motor.servoWrite(0);
  }, 3000);
};

export { sendPicToCloud, initializeServo };
