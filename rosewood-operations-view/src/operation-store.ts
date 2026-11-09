export const OPERATION_CONTAINERS = ['rw-mc-wms-operations', 'rw-mc-oms-operations', 'rw-mc-pim-reports'] as const;
export type OperationContainer = typeof OPERATION_CONTAINERS[number];
export type OperationApi = <T>(path: string, payload?: unknown) => Promise<T>;
export type OperationDocument<T extends object = Record<string, unknown>> = {
  id: string; container: OperationContainer; key: string; version: number;
  createdAt: string; lastModifiedAt: string; value: T;
};
export type OperationCursor = {createdAt: string; key: string};
export type OperationPage<T extends object> = {results: OperationDocument<T>[]; nextCursor?: OperationCursor};
export type OperationListFilters = {type?: 'transfer' | 'count'; sku?: string; status?: string; reference?: string};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validateOperationKey(key: string): void {
  if (typeof key !== 'string' || !UUID.test(key)) throw new Error('The operation key must be a valid UUID.');
}
export function validateOperationContainer(container: string): asserts container is OperationContainer {
  if (!OPERATION_CONTAINERS.includes(container as OperationContainer)) throw new Error('Access to this operation container is not allowed.');
}
export function operationStatus(error: unknown): number | undefined {
  const value = error as {status?: number; statusCode?: number; response?: {status?: number}};
  return value?.statusCode ?? value?.status ?? value?.response?.status;
}
export class OperationWriteError extends Error {
  readonly outcome: 'conflict' | 'unknown' | 'rejected';
  readonly status?: number;
  constructor(error: unknown) {
    const status = operationStatus(error);
    const outcome = status === 409 ? 'conflict' : status && status >= 400 && status < 500 && status !== 408 && status !== 429 ? 'rejected' : 'unknown';
    super(outcome === 'conflict' ? 'The operation changed or already exists. Reload it; existing records will not be overwritten.' : outcome === 'unknown' ? 'The write outcome is unconfirmed. Reload the original operation key; do not create a duplicate or retry automatically.' : 'The operation write was rejected. Check permissions and data, then reload.');
    this.name = 'OperationWriteError'; this.outcome = outcome; this.status = status;
  }
}
function checkedValue<T extends object>(value: T): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The operation value must be a JSON object.');
  try { return JSON.parse(JSON.stringify(value)) as T; }
  catch { throw new Error('The operation must serialize as JSON without circular references.'); }
}
function checkedDocument<T extends object>(document: OperationDocument<T>, container: OperationContainer, key?: string): OperationDocument<T> {
  if (!document || document.container !== container || (key !== undefined && document.key !== key)) throw new Error('The operation response does not match the request.');
  validateOperationKey(document.key);
  if (!Number.isSafeInteger(document.version) || document.version < 1 || !document.id || !document.value || typeof document.value !== 'object' || Array.isArray(document.value)) throw new Error('The operation response has no valid version or content.');
  return document;
}
export async function readOperation<T extends object>(api: OperationApi, container: string, key: string): Promise<OperationDocument<T> | undefined> {
  validateOperationContainer(container); validateOperationKey(key);
  try { return checkedDocument(await api<OperationDocument<T>>(`custom-objects/${container}/${key}`), container, key); }
  catch (error) { if (operationStatus(error) === 404) return undefined; throw error; }
}
async function writeOperation<T extends object>(api: OperationApi, container: string, key: string, version: number, value: T): Promise<OperationDocument<T>> {
  validateOperationContainer(container); validateOperationKey(key);
  if (!Number.isSafeInteger(version) || version < 0) throw new Error('A valid expected operation version is required.');
  const payload = {container, key, version, value: checkedValue(value)};
  try { return checkedDocument(await api<OperationDocument<T>>('custom-objects', payload), container, key); }
  catch (error) { throw new OperationWriteError(error); }
}
export function createOperation<T extends object>(api: OperationApi, container: string, key: string, value: T): Promise<OperationDocument<T>> {
  return writeOperation(api, container, key, 0, value);
}
export function updateOperation<T extends object>(api: OperationApi, document: OperationDocument<T>, value: T): Promise<OperationDocument<T>> {
  if (!Number.isSafeInteger(document.version) || document.version < 1) throw new Error('Updates require the operation version read from the platform.');
  return writeOperation(api, document.container, document.key, document.version, value);
}
function operationFilters(container: OperationContainer, filters?: OperationListFilters): Record<string, string> {
  if (!filters) return {};
  if (container !== 'rw-mc-wms-operations' || typeof filters !== 'object' || Array.isArray(filters)) throw new Error('Warehouse filters are not supported for this container.');
  const limits: Record<string, number> = {type: 16, sku: 256, status: 32, reference: 120};
  const result: Record<string, string> = {};
  for (const [field, value] of Object.entries(filters)) {
    if (!Object.hasOwn(limits, field)) throw new Error('This operation filter field is not supported.');
    if (value === undefined || value === '') continue;
    if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value) || value.trim().length > limits[field]) throw new Error('The operation filter is invalid or too long.');
    const text = value.trim();
    if (text) result[field] = text;
  }
  if (result.type && !['transfer', 'count'].includes(result.type)) throw new Error('Invalid warehouse document type.');
  if (result.status && !['planned', 'in_transit', 'received', 'counted', 'reviewed', 'applied', 'closed_no_change', 'cancelled'].includes(result.status)) throw new Error('Invalid warehouse document status.');
  return result;
}
export async function listOperations<T extends object>(api: OperationApi, container: string, cursor?: OperationCursor, filters?: OperationListFilters): Promise<OperationPage<T>> {
  validateOperationContainer(container);
  const selectedFilters = operationFilters(container, filters);
  const query = new URLSearchParams({limit: '20', withTotal: 'false'});
  query.append('sort', 'createdAt desc'); query.append('sort', 'key asc');
  const predicates = Object.entries(selectedFilters).map(([field, value]) => `value(${field} = ${JSON.stringify(value)})`);
  if (cursor) {
    validateOperationKey(cursor.key);
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(cursor.createdAt) || !Number.isFinite(Date.parse(cursor.createdAt))) throw new Error('Invalid operations pagination cursor.');
    predicates.push(`(createdAt < ${JSON.stringify(cursor.createdAt)} or (createdAt = ${JSON.stringify(cursor.createdAt)} and key > ${JSON.stringify(cursor.key)}))`);
  }
  if (predicates.length) query.set('where', predicates.join(' and '));
  const page = await api<{results: OperationDocument<T>[]}>(`custom-objects/${container}?${query}`);
  if (!Array.isArray(page.results) || page.results.length > 20) throw new Error('Invalid operation list response.');
  const seen = new Set<string>();
  const results = page.results.map(document => {
    checkedDocument(document, container);
    if (Object.entries(selectedFilters).some(([field, value]) => (document.value as Record<string, unknown>)[field] !== value)) throw new Error('The operation does not match the selected filters. Reload the list.');
    if (seen.has(document.key) || (cursor && document.key === cursor.key) || !Number.isFinite(Date.parse(document.createdAt))) throw new Error('The operation list contains duplicate records or invalid times.');
    seen.add(document.key); return document;
  });
  const last = results.at(-1);
  return {results, ...(results.length === 20 && last ? {nextCursor: {createdAt: last.createdAt, key: last.key}} : {})};
}
