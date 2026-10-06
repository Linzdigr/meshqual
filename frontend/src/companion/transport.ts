import { SerialFramer, serialFrame } from './protocol'

/**
 * A link to a MeshCore companion radio from the browser: Bluetooth LE (Nordic
 * UART service, one protocol frame per write or notification) or USB serial
 * (framed, 115200 baud). Chromium browsers only, over HTTPS or localhost.
 */
export interface Transport {
  send(frame: Uint8Array): Promise<void>
  close(): Promise<void>
}

export interface TransportEvents {
  onFrame: (frame: Uint8Array) => void
  /** The radio went away (out of range, unplugged, closed by the user). */
  onClose: () => void
}

export type TransportKind = 'ble' | 'serial'

const UART_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e'
const UART_RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e' // app → radio
const UART_TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e' // radio → app

export function supported(): Record<TransportKind, boolean> {
  return {
    ble: typeof navigator !== 'undefined' && !!navigator.bluetooth,
    serial: typeof navigator !== 'undefined' && !!navigator.serial,
  }
}

export async function connect(kind: TransportKind, ev: TransportEvents): Promise<Transport> {
  return kind === 'ble' ? connectBle(ev) : connectSerial(ev)
}

async function connectBle(ev: TransportEvents): Promise<Transport> {
  const device = await navigator.bluetooth!.requestDevice({ filters: [{ services: [UART_SERVICE] }] })
  const server = await device.gatt!.connect()
  const service = await server.getPrimaryService(UART_SERVICE)
  const rx = await service.getCharacteristic(UART_RX)
  const tx = await service.getCharacteristic(UART_TX)
  tx.addEventListener('characteristicvaluechanged', () => {
    const v = tx.value
    if (v) ev.onFrame(new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)))
  })
  device.addEventListener('gattserverdisconnected', () => ev.onClose())
  await tx.startNotifications()
  return {
    send: (frame) => rx.writeValueWithResponse(frame),
    close: async () => server.disconnect(),
  }
}

async function connectSerial(ev: TransportEvents): Promise<Transport> {
  const port = await navigator.serial!.requestPort()
  await port.open({ baudRate: 115200 })
  const writer = port.writable!.getWriter()
  const reader = port.readable!.getReader()
  const framer = new SerialFramer()
  let closing = false

  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        if (value) for (const f of framer.push(value)) ev.onFrame(f)
      }
    } catch {
      // unplugged: fall through to close
    } finally {
      if (!closing) ev.onClose()
    }
  })()

  return {
    send: (frame) => writer.write(serialFrame(frame)),
    close: async () => {
      closing = true
      await reader.cancel().catch(() => {})
      reader.releaseLock()
      writer.releaseLock()
      await port.close().catch(() => {})
      ev.onClose()
    },
  }
}
