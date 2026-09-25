import type { Advert, Driver } from './gatt.ts';
import { inkbirdBwDriver } from './inkbird-bw.ts';
import { ibbqDriver } from './ibbq.ts';

export const DRIVERS: Driver[] = [inkbirdBwDriver, ibbqDriver];

export function findDriver(adv: Advert): { driver: Driver; model: string } | null {
  for (const driver of DRIVERS) {
    const model = driver.match(adv);
    if (model) return { driver, model };
  }
  return null;
}
