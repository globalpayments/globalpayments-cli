export interface RecordedCall {
  seq: number;
  status: number;
  tStart?: number;
  tEnd?: number;
  responseActionId?: string;
  responseActionType?: string;
}

export interface LoggedAction {
  id: string;
  type: string;
  time_created: string;
  http_response_code?: string;
  resource?: string;
}

export function caseEndpoints(name: string | undefined): string[];
export function gpTime(value: string | undefined): number;
export function evidenceOf(tags?: string[]): string | undefined;
export function placeholderPath(endpointPath: string): string;
export function reconcile(calls: RecordedCall[], actions: LoggedAction[], toleranceMs?: number): Map<number, LoggedAction>;
export function verdictFor(
  currentType: string | undefined,
  observed: { type: string } | undefined,
  httpStatus: number
): 'confirmed' | 'corrected' | 'not-logged' | 'unverified';
export function applyObservedType(yamlText: string, observedType: string, date: string, sharesTypeWith?: string[]): string;
