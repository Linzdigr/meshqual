// The slice of Web Bluetooth and Web Serial the companion link uses. Both are
// Chromium-only and missing from TypeScript's DOM library; declared here rather
// than pulling in two type packages for a handful of members.

interface BluetoothRemoteGATTCharacteristic extends EventTarget {
  readonly value?: DataView
  startNotifications(): Promise<BluetoothRemoteGATTCharacteristic>
  writeValueWithResponse(value: BufferSource): Promise<void>
}

interface BluetoothRemoteGATTService {
  getCharacteristic(uuid: string): Promise<BluetoothRemoteGATTCharacteristic>
}

interface BluetoothRemoteGATTServer {
  readonly connected: boolean
  connect(): Promise<BluetoothRemoteGATTServer>
  disconnect(): void
  getPrimaryService(uuid: string): Promise<BluetoothRemoteGATTService>
}

interface BluetoothDevice extends EventTarget {
  readonly name?: string
  readonly gatt?: BluetoothRemoteGATTServer
}

interface Bluetooth {
  requestDevice(options: {
    filters: ({ services: string[] } | { namePrefix: string })[]
    optionalServices?: string[]
  }): Promise<BluetoothDevice>
}

interface SerialPort {
  readonly readable: ReadableStream<Uint8Array> | null
  readonly writable: WritableStream<Uint8Array> | null
  open(options: { baudRate: number }): Promise<void>
  close(): Promise<void>
}

interface Serial {
  requestPort(): Promise<SerialPort>
}

interface Navigator {
  readonly bluetooth?: Bluetooth
  readonly serial?: Serial
}
