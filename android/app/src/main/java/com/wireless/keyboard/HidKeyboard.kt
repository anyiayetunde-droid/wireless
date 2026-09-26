package com.wireless.keyboard

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothHidDevice
import android.bluetooth.BluetoothHidDeviceAppSdpSettings
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import java.util.concurrent.Executor
import java.util.concurrent.Executors

/**
 * Wraps the BluetoothHidDevice profile so the phone presents itself to the
 * laptop as a standard Bluetooth keyboard. Reports are the classic 8-byte
 * boot-keyboard format: modifiers | reserved | key1..key6.
 */
object HidKeyboard {

    private const val TAG = "WirelessHid"
    private const val REPORT_ID = 0 // report descriptor has no report ID (sendReport takes an int)

    // Standard boot-keyboard report descriptor (8-byte report, no report ID).
    private val REPORT_DESCRIPTOR = byteArrayOf(
        0x05, 0x01, // Usage Page (Generic Desktop)
        0x09, 0x06, // Usage (Keyboard)
        0xA1.toByte(), 0x01, // Collection (Application)
        0x05, 0x07, //   Usage Page (Key Codes)
        0x19, 0xE0.toByte(), //   Usage Minimum (224)
        0x29, 0xE7.toByte(), //   Usage Maximum (231)
        0x15, 0x00, //   Logical Minimum (0)
        0x25, 0x01, //   Logical Maximum (1)
        0x75, 0x01, //   Report Size (1)
        0x95.toByte(), 0x08, //   Report Count (8)
        0x81.toByte(), 0x02, //   Input (Data, Variable, Absolute) : modifier byte
        0x75, 0x08, //   Report Size (8)
        0x95.toByte(), 0x01, //   Report Count (1)
        0x81.toByte(), 0x01, //   Input (Constant) : reserved byte
        0x75, 0x08, //   Report Size (8)
        0x95.toByte(), 0x06, //   Report Count (6)
        0x15, 0x00, //   Logical Minimum (0)
        0x25, 0x65, //   Logical Maximum (101)
        0x05, 0x07, //   Usage Page (Key Codes)
        0x19, 0x00, //   Usage Minimum (0)
        0x29, 0x65, //   Usage Maximum (101)
        0x81.toByte(), 0x00, //   Input (Data, Array) : key array (6 keys)
        0xC0.toByte(), // End Collection
    )

    private val executor: Executor = Executors.newSingleThreadExecutor()
    private val mainHandler = Handler(Looper.getMainLooper())

    var hidDevice: BluetoothHidDevice? = null
        private set

    var device: BluetoothDevice? = null
        private set

    /** Called on the main thread with human-readable status. */
    var onState: (String) -> Unit = {}

    private var serviceListener: BluetoothProfile.ServiceListener? = null
    private var adapter: BluetoothAdapter? = null
    private var lastReport: ByteArray? = null

    private fun post(fn: () -> Unit) {
        mainHandler.post(fn)
    }

    private fun displayName(d: BluetoothDevice) = d.name ?: d.address

    private val sdpSettings by lazy {
        BluetoothHidDeviceAppSdpSettings(
            "Wireless Keyboard",
            "Type on your computer from your phone",
            "Wireless",
            BluetoothHidDevice.SUBCLASS1_KEYBOARD,
            REPORT_DESCRIPTOR,
        )
    }

    private val callback = object : BluetoothHidDevice.Callback() {
        override fun onAppStatusChanged(pluggedDevice: BluetoothDevice?, registered: Boolean) {
            post {
                if (registered) onState("Keyboard ready — pick a device below")
                else onState("HID app registration lost")
            }
        }

        override fun onConnectionStateChanged(bluetoothDevice: BluetoothDevice, state: Int) {
            post {
                when (state) {
                    BluetoothProfile.STATE_CONNECTED -> {
                        device = bluetoothDevice
                        onState("Connected to ${displayName(bluetoothDevice)} — click a text field on it and type")
                    }
                    BluetoothProfile.STATE_CONNECTING -> onState("Connecting…")
                    BluetoothProfile.STATE_DISCONNECTED -> {
                        if (device == bluetoothDevice) device = null
                        onState("Disconnected")
                    }
                    else -> { /* DISCONNECTING */ }
                }
            }
        }

        override fun onGetReport(bluetoothDevice: BluetoothDevice, type: Byte, id: Byte, bufferSize: Int) {
            // Host asked for the current report (boot protocol probing).
            hidDevice?.replyReport(bluetoothDevice, type, id, lastReport ?: ByteArray(8))
        }

        override fun onSetReport(bluetoothDevice: BluetoothDevice, type: Byte, id: Byte, data: ByteArray) {
            // Report protocol: nothing to configure.
        }

        override fun onSetProtocol(bluetoothDevice: BluetoothDevice, protocol: Byte) {
            // We stay in report protocol for the full key set — nothing to do.
        }

        override fun onInterruptData(bluetoothDevice: BluetoothDevice, reportId: Byte, data: ByteArray) {
            // Output reports from the host (e.g. LEDs) — ignored.
        }

        override fun onVirtualCableUnplug(bluetoothDevice: BluetoothDevice) {
            post {
                if (device == bluetoothDevice) device = null
                onState("Host disconnected the virtual cable")
            }
        }
    }

    /** Start listening for HID connections. Requires Bluetooth on + permissions. */
    fun register(context: Context) {
        val bm = context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
        adapter = bm.adapter
        val a = adapter
        if (a == null) {
            onState("No Bluetooth adapter on this device")
            return
        }
        if (!a.isEnabled) {
            onState("Bluetooth is turned off")
            return
        }
        if (serviceListener == null) {
            serviceListener = object : BluetoothProfile.ServiceListener {
                override fun onServiceConnected(profile: Int, proxy: BluetoothProfile) {
                    hidDevice = proxy as BluetoothHidDevice
                    val ok = try {
                        hidDevice?.registerApp(sdpSettings, null, null, executor, callback) == true
                    } catch (e: SecurityException) {
                        onState("Bluetooth permission denied")
                        false
                    }
                    post {
                        if (ok) onState("Ready — pair with your computer, then tap it below")
                        else onState("Could not register the HID keyboard")
                    }
                }

                override fun onServiceDisconnected(profile: Int) {
                    hidDevice = null
                    post { onState("HID profile lost — restart the app") }
                }
            }
            a.getProfileProxy(context, serviceListener!!, BluetoothProfile.HID_DEVICE)
        } else {
            onState("Already registered")
        }
    }

    fun isRegistered(): Boolean = hidDevice != null

    fun connect(dev: BluetoothDevice) {
        val h = hidDevice
        if (h == null) {
            onState("HID keyboard not ready yet")
            return
        }
        val ok = try {
            h.connect(dev)
        } catch (e: SecurityException) {
            onState("Bluetooth permission denied")
            false
        }
        onState(if (ok) "Connecting to ${displayName(dev)}…" else "connect failed — is it paired?")
    }

    fun disconnectCurrent() {
        val h = hidDevice ?: return
        val d = device ?: return
        try {
            h.disconnect(d)
        } catch (e: SecurityException) {
            /* ignore */
        }
    }

    /** Send a report with up to six simultaneous key usages + modifier flags. */
    fun sendDown(modifiers: Int, vararg usages: Int) {
        val report = ByteArray(8)
        report[0] = modifiers.toByte()
        val n = minOf(usages.size, 6)
        for (i in 0 until n) report[2 + i] = usages[i].toByte()
        lastReport = report
        val h = hidDevice
        val d = device
        if (h != null && d != null) {
            try {
                h.sendReport(d, REPORT_ID, report)
            } catch (e: Exception) {
                Log.e(TAG, "sendReport failed", e)
            }
        }
    }

    fun releaseAll() = sendDown(0)

    /** Press and release one key. */
    fun tap(modifiers: Int, usage: Int) {
        sendDown(modifiers, usage)
        mainHandler.postDelayed({ releaseAll() }, 40)
    }
}
