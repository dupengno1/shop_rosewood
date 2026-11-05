import type {Inventory} from './api';

export type InventoryTarget =
  | {kind: 'entry'; id: string}
  | {kind: 'sku'; sku: string};
export type InventoryReader = <T>(path: string) => Promise<T>;

const resourceId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function readInventoryRows(read: InventoryReader, target: InventoryTarget): Promise<Inventory[]> {
  if (target.kind === 'entry') {
    if (!resourceId.test(target.id)) throw new Error('The inventory entry ID is invalid. Reopen the native inventory detail page.');
    const entry = await read<Inventory>(`inventory/${encodeURIComponent(target.id)}?expand=supplyChannel`);
    if (entry.id !== target.id || !entry.sku?.trim()) {
      throw new Error('The returned inventory record does not match this detail page. Reopen the native inventory detail page before editing.');
    }
    return [entry];
  }

  const result: Inventory[] = [];
  let last = '';
  for (;;) {
    const query = new URLSearchParams({
      where: `sku=${JSON.stringify(target.sku)}${last ? ` and id > ${JSON.stringify(last)}` : ''}`,
      limit: '100', sort: 'id asc', expand: 'supplyChannel', withTotal: 'false',
    });
    const page = await read<{results: Inventory[]}>(`inventory?${query}`);
    result.push(...page.results);
    if (page.results.length < 100) return result;
    const next = page.results.at(-1)!.id;
    if (next === last) throw new Error('Inventory pagination did not advance. Reload before editing.');
    last = next;
  }
}
