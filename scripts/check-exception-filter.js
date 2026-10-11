/**
 * Checks that HttpExceptionFilter forwards a thrown `errors` array.
 *
 * Run against dist:  node scripts/check-exception-filter.js
 *
 * Why this is worth a check rather than a glance: the filter copies named
 * fields off the exception response, so any key it does not know about is
 * dropped silently. Both the integration-config validator and the rule-chain
 * graph validator throw `BadRequestException({ message, errors })` so a form
 * can show every invalid field at once — and before this was wired, all of that
 * detail arrived at the client as a single sentence.
 */
const { BadRequestException } = require('@nestjs/common');
const {
  HttpExceptionFilter,
} = require('../dist/common/filters/http-exception.filter.js');

let captured = null;
const host = {
  switchToHttp: () => ({
    getResponse: () => ({
      status: () => ({
        json: (body) => {
          captured = body;
        },
      }),
    }),
    getRequest: () => ({ url: '/rule-chains/x/metadata', method: 'PUT' }),
  }),
};

new HttpExceptionFilter().catch(
  new BadRequestException({
    message: 'The rule chain graph is not valid',
    errors: [
      'Action: "Action" is required',
      'Filter: "Condition" is required',
    ],
  }),
  host,
);

console.log('statusCode:', captured && captured.statusCode);
console.log('message   :', captured && captured.message);
console.log('errors    :', captured && captured.errors);

const ok =
  captured &&
  captured.statusCode === 400 &&
  Array.isArray(captured.errors) &&
  captured.errors.length === 2;

console.log(
  ok
    ? '\nPASS — field-level errors reach the client'
    : '\nFAIL — the errors array is still being dropped',
);
process.exit(ok ? 0 : 1);
