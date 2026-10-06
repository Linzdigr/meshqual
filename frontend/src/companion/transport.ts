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

/** The user closed the browser's device picker: not an error to report. */
export class Cancelled extends Error {}

/** A failed connection step, with what to tell the user. */
export class ConnectError extends Error {}

const BLUETOOTH_OFF =
  "Bluetooth indisponible : vérifiez qu'il est activé et que le navigateur a le droit de l'utiliser " +
  '(macOS : Réglages Système › Confidentialité et sécurité › Bluetooth ; Linux : activer ' +
  'chrome://flags/#enable-web-bluetooth ; Brave : brave://flags/#brave-web-bluetooth-api)'

function isCancel(e: unknown) {
  const err = e as { name?: string; message?: string }
  return err.name === 'NotFoundError' && /cancel/i.test(err.message ?? '')
}

async function connectBle(ev: TransportEvents): Promise<Transport> {
  const bt = navigator.bluetooth!
  if (bt.getAvailability && !(await bt.getAvailability().catch(() => true))) {
    throw new ConnectError(BLUETOOTH_OFF)
  }
  let device: BluetoothDevice
  try {
    // Companions advertise the UART service; the name prefix catches any
    // firmware that leaves it to the scan response.
    device = await bt.requestDevice({
      filters: [{ services: [UART_SERVICE] }, { namePrefix: 'MeshCore' }],
      optionalServices: [UART_SERVICE],
    })
  } catch (e) {
    if (isCancel(e)) throw new Cancelled()
    const err = e as { name?: string; message?: string }
    if (err.name === 'NotFoundError') throw new ConnectError(`${BLUETOOTH_OFF}. (${err.message})`)
    throw new ConnectError(`Bluetooth : ${err.message ?? String(e)}`)
  }
  // The companion's characteristics require an encrypted, PIN-paired link:
  // the system asks for the PIN on first access.
  const step = async <T>(what: string, f: () => Promise<T>): Promise<T> => {
    try {
      return await f()
    } catch (e) {
      device.gatt?.disconnect()
      const msg = ((e as { message?: string }).message ?? String(e)).replace(/\.$/, '')
      throw new ConnectError(
        `${what} : ${msg}. Si l'appairage a échoué, oubliez l'appareil dans les réglages Bluetooth ` +
          'du système puis réessayez avec le code PIN affiché par le compagnon.',
      )
    }
  }
  const server = await step('connexion au compagnon', () => device.gatt!.connect())
  const service = await step('service série introuvable', () => server.getPrimaryService(UART_SERVICE))
  const rx = await step('caractéristique RX', () => service.getCharacteristic(UART_RX))
  const tx = await step('caractéristique TX', () => service.getCharacteristic(UART_TX))
  tx.addEventListener('characteristicvaluechanged', () => {
    const v = tx.value
    if (v) ev.onFrame(new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)))
  })
  device.addEventListener('gattserverdisconnected', () => ev.onClose())
  await step('abonnement aux notifications (appairage)', () => tx.startNotifications())
  return {
    send: (frame) => rx.writeValueWithResponse(frame),
    close: async () => server.disconnect(),
  }
}

async function connectSerial(ev: TransportEvents): Promise<Transport> {
  let port: SerialPort
  try {
    port = await navigator.serial!.requestPort()
  } catch (e) {
    if ((e as { name?: string }).name === 'NotFoundError') throw new Cancelled() // picker closed
    throw new ConnectError(`USB : ${(e as { message?: string }).message ?? String(e)}`)
  }
  try {
    await port.open({ baudRate: 115200 })
  } catch (e) {
    throw new ConnectError(
      `ouverture du port USB : ${(e as { message?: string }).message ?? String(e)}. ` +
        "Une autre application (app MeshCore, flasheur, terminal) l'utilise peut-être.",
    )
  }
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
