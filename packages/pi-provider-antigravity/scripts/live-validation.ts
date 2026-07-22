export interface LiveValidationResultInput {
	expectedWireModel: string;
	payloadModel?: string;
	statuses: number[];
	stopReason: string;
	response: string;
}

/** Evaluate a bounded primary-endpoint text happy path. Fallback behavior is out of scope. */
export function isSuccessfulLiveValidation(input: LiveValidationResultInput, allowedAttemptCount = 1): boolean {
	return (
		input.payloadModel === input.expectedWireModel &&
		input.statuses.length >= 1 &&
		input.statuses.length <= allowedAttemptCount &&
		input.statuses.every((status) => status === 200) &&
		input.stopReason === "stop" &&
		input.response.replace(/\.$/, "") === "OK"
	);
}
