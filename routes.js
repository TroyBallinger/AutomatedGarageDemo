var router = require('express').Router();
var { openDoor } = require('./controller.js');

// Open door
router.get('/opendoor', (request, response) => {
	console.log('opening door...');
	openDoor();
	return response.status(200).json({'message': 'opening door...'});
});

module.exports = router