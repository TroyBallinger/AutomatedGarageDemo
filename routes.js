var router = require('express').Router();

// Open door
router.get('/opendoor', (request, response) => {
	console.log('opening door...');
	return response.status(200).json({'message': 'opening door...'});
});

// Close door
router.get('/closedoor', (request, response) => {
	console.log('closing door...');
	return response.status(200).json({'message': 'closing door...'});
});

module.exports = router