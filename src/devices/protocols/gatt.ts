// A tiny abstraction over a connected GATT peripheral so protocol drivers can be unit-tested
// against fake devices and reused with any BLE library.

import type { DeviceStatus, SensorValue } from '../types.ts';

export type LogFn = (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void;

const BT_BASE_SUFFIX = '00001000800000805f9b34fb';

/** "0000FF01-0000-1000-8000-00805F9B34FB" → "ff01"; custom 128-bit UUIDs stay 32 hex chars. */
export function normUuid(uuid: string): string {
  const u = uuid.toLowerCase().replace(/-/g, '');
  if (u.length === 32 && u.startsWith('0000') && u.endsWith(BT_BASE_SUFFIX)) return u.slice(4, 8);
  return u;
}

export interface GattLink {
  has(uuid: string): boolean;
  write(uuid: string, data: Buffer): Promise<void>;
  read(uuid: string): Promise<Buffer>;
  subscribe(uuid: string, onData: (data: Buffer) => void): Promise<void>;
}

export interface Advert {
  name: string;
  serviceUuids: string[];
  manufacturerData: Buffer | null;
}

export interface DriverContext {
  log: LogFn;
  sensors(values: SensorValue[]): void;
  status(patch: Partial<Pick<DeviceStatus, 'batteryPct' | 'state' | 'batteries' | 'model'>>): void;
  /** Ask the BLE layer to drop and re-establish the connection. */
  reconnect(reason: string): void;
  now(): number;
}

export interface DriverSession {
  stop(): void;
}

export interface Driver {
  id: string;
  /** Model name if this advertisement belongs to a device this driver can talk to. */
  match(adv: Advert): string | null;
  run(link: GattLink, ctx: DriverContext, model: string): Promise<DriverSession>;
}

export const hex = (b: Buffer | Uint8Array): string => Buffer.from(b).toString('hex').replace(/(..)(?!$)/g, '$1 ');

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
