// Shared shapes between thermometer sources (Bluetooth, simulator) and the hub.

/** What a sensor physically measures. */
export type SensorKind = 'meat' | 'ambient';

/** Why a sensor has no value (or 'ok'). */
export type SensorStatus = 'ok' | 'docked' | 'no-probe' | 'error' | 'out-of-range';

export interface SensorValue {
  /** Stable index of the sensor on its device (0-based). */
  index: number;
  kind: SensorKind;
  /** null = sensor present but not reporting a valid value (unplugged, out of range, in charger…). */
  tempC: number | null;
  /** Physical name, e.g. "Black probe" / "Black probe (ambient)". */
  name?: string;
  status?: SensorStatus;
}

export interface DeviceStatus {
  /** Stable id: CoreBluetooth UUID on macOS, MAC on Linux, `sim-*` for the simulator. */
  id: string;
  /** Advertised Bluetooth name. */
  name: string;
  /** Protocol/model label, e.g. "INT-12-BW" or "iBBQ". */
  model: string;
  connected: boolean;
  rssi: number | null;
  /** Lowest battery across the base and its probes. */
  batteryPct: number | null;
  /** Individual batteries, e.g. { base: 80, "black probe": 100, "white probe": 96 }. */
  batteries?: Record<string, number>;
  lastSeen: number | null;
  lastData: number | null;
  /** Free-form human readable state ("connecting", "waiting for probe", last error…). */
  state: string;
}

export interface SourceSink {
  device(status: DeviceStatus): void;
  sensors(deviceId: string, values: SensorValue[], at: number): void;
  log(level: 'debug' | 'info' | 'warn' | 'error', msg: string): void;
}

export interface DeviceSource {
  readonly kind: 'ble' | 'sim';
  start(sink: SourceSink): Promise<void>;
  stop(): Promise<void>;
  /** Simulator only: history to preload, plus when that virtual cook started. */
  backfill?(stepMs: number): Iterable<{ t: number; values: Map<string, SensorValue[]> }>;
  readonly cookStart?: number;
  /** Simulator only: react to cook notes ("added fuel", "wrapped"). */
  onNote?(text: string): void;
}
