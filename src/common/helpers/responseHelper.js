/**
 * ------------------------------------------------------------------
 * File: responseHelper.js
 * Module: Backend Utilities
 *
 * Purpose:
 * Backend utility/module providing helper functions for responseHelper.
 *
 * Used By:
 * errorHandler, apiRateLimit.middleware, expense.controller, payee.controller
 * ------------------------------------------------------------------
 */

/**
 * Standardized response helper
 * All API responses should follow the shape:
 * {
 *   message: string,
 *   statuscode: number,
 *   data: any
 * }
 */

const { ClockService, DateUtil } = require('../date');

function success(res, data = null, message = 'Success', statusCode = 200) {
	return res.status(statusCode).json({ message, statuscode: statusCode, data });
}

/**
 * error
 *
 * Performs logic operations for error.
 *
 * @param res - Request/input argument
 * @param message - Request/input argument
 * @param statusCode - Request/input argument
 * @param data - Request/input argument
 * @param errors - Request/input argument
 * @returns Operations result
 */
function error(res, message = 'Internal Server Error', statusCode = 500, data = null, errors = null) {
	// Never forward non-error HTTP codes (1xx, 2xx, 3xx) as API error responses
	if (!statusCode || statusCode < 400) statusCode = 500;
	const response = {
		timestamp: DateUtil.toISO(ClockService.now()),
		status: statusCode,
		error: getStatusText(statusCode),
		message,
		path: res.req?.originalUrl || res.req?.url || '',
		statuscode: statusCode, // Keep for backward compatibility
		data
	};
	
	if (errors && errors.length > 0) {
		response.errors = errors;
	}
	
	return res.status(statusCode).json(response);
}

/**
 * get Status Text
 *
 * Performs logic operations for getStatusText.
 *
 * @param statusCode - Request/input argument
 * @returns Operations result
 */
function getStatusText(statusCode) {
	const statusTexts = {
		400: 'Bad Request',
		401: 'Unauthorized',
		403: 'Forbidden',
		404: 'Not Found',
		409: 'Conflict',
		422: 'Unprocessable Entity',
		423: 'Locked',
		429: 'Too Many Requests',
		500: 'Internal Server Error'
	};
	return statusTexts[statusCode] || 'Unknown Error';
}

module.exports = {
	success,
	error,
};
