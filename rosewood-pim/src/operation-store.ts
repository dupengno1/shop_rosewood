export const OPERATION_CONTAINERS = ['rw-mc-wms-operations', 'rw-mc-oms-operations', 'rw-mc-pim-reports'] as const;
export type OperationContainer = typeof OPERATION_CONTAINERS[number];
export type OperationApi = <T>(path: string, payload?: unknown) => Promise<T>;
export type OperationDocument<T extends object = Record<string, unknown>> = {
  id: string; container: OperationContainer; key: string; version: number;
  createdAt: string; lastModifiedAt: string; value: T;
};
export type OperationCursor = {createdAt: string; key: string};
export type OperationPage<T extends object> = {results: OperationDocument<T>[]; nextCursor?: OperationCursor};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validateOperationKey(key: string): void {
  if (typeof key !== 'string' || !UUID.test(key)) throw new Error('业务单据 key 必须是有效 UUID。');
}
export function validateOperationContainer(container: string): asserts container is OperationContainer {
  if (!OPERATION_CONTAINERS.includes(container as OperationContainer)) throw new Error('不允许访问此业务单据容器。');
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
    super(outcome === 'conflict' ? '业务单据已变化或已存在；请重新读取，不会覆盖现有记录。' : outcome === 'unknown' ? '业务单据写入结果尚未确认；请按原单据 key 回读，不要重复创建或自动重试。' : '业务单据写入被拒绝；请检查权限与数据后重新读取。');
    this.name = 'OperationWriteError'; this.outcome = outcome; this.status = status;
  }
}
function checkedValue<T extends object>(value: T): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('业务单据 value 必须是 JSON 对象。');
  try { return JSON.parse(JSON.stringify(value)) as T; }
  catch { throw new Error('业务单据必须能保存为 JSON，不能包含循环引用。'); }
}
function checkedDocument<T extends object>(document: OperationDocument<T>, container: OperationContainer, key?: string): OperationDocument<T> {
  if (!document || document.container !== container || (key !== undefined && document.key !== key)) throw new Error('业务单据响应与请求不符。');
  validateOperationKey(document.key);
  if (!Number.isSafeInteger(document.version) || document.version < 1 || !document.id || !document.value || typeof document.value !== 'object' || Array.isArray(document.value)) throw new Error('业务单据响应无有效版本或内容。');
  return document;
}
export async function readOperation<T extends object>(api: OperationApi, container: string, key: string): Promise<OperationDocument<T> | undefined> {
  validateOperationContainer(container); validateOperationKey(key);
  try { return checkedDocument(await api<OperationDocument<T>>(`custom-objects/${container}/${key}`), container, key); }
  catch (error) { if (operationStatus(error) === 404) return undefined; throw error; }
}
async function writeOperation<T extends object>(api: OperationApi, container: string, key: string, version: number, value: T): Promise<OperationDocument<T>> {
  validateOperationContainer(container); validateOperationKey(key);
  if (!Number.isSafeInteger(version) || version < 0) throw new Error('业务单据需要有效的预期版本。');
  const payload = {container, key, version, value: checkedValue(value)};
  try { return checkedDocument(await api<OperationDocument<T>>('custom-objects', payload), container, key); }
  catch (error) { throw new OperationWriteError(error); }
}
export function createOperation<T extends object>(api: OperationApi, container: string, key: string, value: T): Promise<OperationDocument<T>> {
  return writeOperation(api, container, key, 0, value);
}
export function updateOperation<T extends object>(api: OperationApi, document: OperationDocument<T>, value: T): Promise<OperationDocument<T>> {
  if (!Number.isSafeInteger(document.version) || document.version < 1) throw new Error('更新需要已读取的业务单据版本。');
  return writeOperation(api, document.container, document.key, document.version, value);
}
export async function listOperations<T extends object>(api: OperationApi, container: string, cursor?: OperationCursor): Promise<OperationPage<T>> {
  validateOperationContainer(container);
  const query = new URLSearchParams({limit: '20', withTotal: 'false'});
  query.append('sort', 'createdAt desc'); query.append('sort', 'key asc');
  if (cursor) {
    validateOperationKey(cursor.key);
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(cursor.createdAt) || !Number.isFinite(Date.parse(cursor.createdAt))) throw new Error('业务单据分页游标无效。');
    query.set('where', `createdAt < ${JSON.stringify(cursor.createdAt)} or (createdAt = ${JSON.stringify(cursor.createdAt)} and key > ${JSON.stringify(cursor.key)})`);
  }
  const page = await api<{results: OperationDocument<T>[]}>(`custom-objects/${container}?${query}`);
  if (!Array.isArray(page.results) || page.results.length > 20) throw new Error('业务单据列表响应无效。');
  const seen = new Set<string>();
  const results = page.results.map(document => {
    checkedDocument(document, container);
    if (seen.has(document.key) || (cursor && document.key === cursor.key) || !Number.isFinite(Date.parse(document.createdAt))) throw new Error('业务单据列表包含重复记录或无效时间。');
    seen.add(document.key); return document;
  });
  const last = results.at(-1);
  return {results, ...(results.length === 20 && last ? {nextCursor: {createdAt: last.createdAt, key: last.key}} : {})};
}
