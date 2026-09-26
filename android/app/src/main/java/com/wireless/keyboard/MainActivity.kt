package com.wireless.keyboard

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

/**
 * Pairs with a computer and sends real keyboard input over Bluetooth using the
 * BluetoothHidDevice API (the phone acts as a Bluetooth keyboard).
 */
class MainActivity : AppCompatActivity() {

    private companion object {
        const val REQ_BT = 1001
        val NEEDED_PERMS = if (Build.VERSION.SDK_INT >= 31) {
            arrayOf(
                Manifest.permission.BLUETOOTH_CONNECT,
                Manifest.permission.BLUETOOTH_SCAN,
            )
        } else {
            emptyArray()
        }
    }

    private lateinit var tvStatus: TextView
    private lateinit var listPaired: ListView
    private lateinit var listFound: ListView
    private lateinit var btnScan: Button
    private lateinit var btnDisconnect: Button
    private lateinit var keyboardHost: LinearLayout

    private lateinit var btnModeBt: Button
    private lateinit var btnModeWifi: Button
    private lateinit var btPanel: LinearLayout
    private lateinit var wifiPanel: LinearLayout
    private lateinit var tvWifiStatus: TextView
    private lateinit var etWifiHost: EditText
    private lateinit var etWifiPort: EditText
    private lateinit var etWifiPin: EditText
    private lateinit var btnWifiConnect: Button

    private val pairedNames = ArrayList<String>()
    private val pairedDevices = LinkedHashMap<String, BluetoothDevice>()
    private val foundNames = ArrayList<String>()
    private val foundDevices = LinkedHashMap<String, BluetoothDevice>()

    private lateinit var pairedAdapter: ArrayAdapter<String>
    private lateinit var foundAdapter: ArrayAdapter<String>

    private var btAdapter: BluetoothAdapter? = null
    private var receiver: BroadcastReceiver? = null
    private val handler = Handler(Looper.getMainLooper())

    // On-screen keyboard state: shift capitalises the next letter only, like a
    // phone keyboard; shift stays highlighted and re-pressing toggles caps lock.
    private var layerLetters = true
    private var shift = false
    private var caps = false
    private var lastShiftTap = 0L

    // ---------- lifecycle ----------

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        tvStatus = findViewById(R.id.tvStatus)
        listPaired = findViewById(R.id.listPaired)
        listFound = findViewById(R.id.listFound)
        btnScan = findViewById(R.id.btnScan)
        btnDisconnect = findViewById(R.id.btnDisconnect)
        keyboardHost = findViewById(R.id.keyboardHost)

        pairedAdapter = ArrayAdapter(this, android.R.layout.simple_list_item_1, pairedNames)
        foundAdapter = ArrayAdapter(this, android.R.layout.simple_list_item_1, foundNames)
        listPaired.adapter = pairedAdapter
        listFound.adapter = foundAdapter

        val bm = getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
        btAdapter = bm.adapter

        HidKeyboard.onState = { msg ->
            runOnUiThread {
                tvStatus.text = msg
                val connected = HidKeyboard.device != null
                btnDisconnect.isEnabled = connected
                btnScan.isEnabled = !connected
            }
        }

        listPaired.setOnItemClickListener { _, _, position, _ ->
            val name = pairedNames[position]
            val dev = pairedDevices[name] ?: return@setOnItemClickListener
            HidKeyboard.connect(dev)
        }

        listFound.setOnItemClickListener { _, _, position, _ ->
            val name = foundNames[position]
            val dev = foundDevices[name] ?: return@setOnItemClickListener
            try {
                if (dev.bondState == BluetoothDevice.BOND_BONDED) {
                    HidKeyboard.connect(dev)
                } else {
                    dev.createBond()
                    toast("Pairing with $name… accept it on the computer")
                }
            } catch (e: SecurityException) {
                toast(getString(R.string.perm_denied))
            }
        }

        btnScan.setOnClickListener { startScan() }
        btnDisconnect.setOnClickListener { HidKeyboard.disconnectCurrent() }

        buildKeyboard()
        setupWifiMode()

        if (NEEDED_PERMS.isNotEmpty() && !hasPermissions()) {
            ActivityCompat.requestPermissions(this, NEEDED_PERMS, REQ_BT)
        } else {
            onPermissionsReady()
        }
    }

    override fun onResume() {
        super.onResume()
        if (hasPermissions()) refreshPaired()
    }

    override fun onDestroy() {
        WifiRemote.removeStateListener(wifiStateListener)
        super.onDestroy()
        unregisterDiscovery()
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_BT) {
            if (grantResults.isNotEmpty() && grantResults.all { it == PackageManager.PERMISSION_GRANTED }) {
                onPermissionsReady()
            } else {
                tvStatus.text = getString(R.string.perm_denied)
                toast(getString(R.string.perm_denied))
            }
        }
    }

    private fun hasPermissions(): Boolean =
        NEEDED_PERMS.all {
            ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED
        }

    private fun onPermissionsReady() {
        HidKeyboard.register(applicationContext)
        refreshPaired()
    }

    // ---------- bluetooth ----------

    private fun refreshPaired() {
        val a = btAdapter ?: return
        if (!a.isEnabled) {
            tvStatus.text = "Bluetooth is off — turn it on in Settings"
            return
        }
        pairedNames.clear()
        pairedDevices.clear()
        try {
            a.bondedDevices.forEach { d ->
                val name = d.name ?: d.address
                pairedNames.add(name)
                pairedDevices[name] = d
            }
        } catch (e: SecurityException) {
            /* permission raced with Bluetooth toggling */
        }
        pairedAdapter.notifyDataSetChanged()
    }

    private fun startScan() {
        val a = btAdapter ?: return
        if (!a.isEnabled || !hasPermissions()) return
        foundNames.clear()
        foundDevices.clear()
        foundAdapter.notifyDataSetChanged()
        btnScan.isEnabled = false
        btnScan.text = "Scanning…"
        registerDiscovery()
        try {
            a.startDiscovery()
        } catch (e: SecurityException) {
            btnScan.isEnabled = true
            btnScan.text = "Scan"
        }
    }

    private fun registerDiscovery() {
        if (receiver != null) return
        val r = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                when (intent?.action) {
                    BluetoothDevice.ACTION_FOUND -> {
                        val dev = findDevice(intent)
                        if (dev != null) {
                            val name = dev.name ?: dev.address
                            if (!foundDevices.containsKey(name) && name.isNotBlank()) {
                                foundNames.add(name)
                                foundDevices[name] = dev
                                foundAdapter.notifyDataSetChanged()
                            }
                        }
                    }
                    BluetoothAdapter.ACTION_DISCOVERY_FINISHED -> {
                        btnScan.isEnabled = true
                        btnScan.text = "Scan"
                    }
                    BluetoothDevice.ACTION_BOND_STATE_CHANGED -> {
                        val dev = findDevice(intent)
                        val state = intent.getIntExtra(BluetoothDevice.EXTRA_BOND_STATE, BluetoothDevice.ERROR)
                        if (dev != null && state == BluetoothDevice.BOND_BONDED) {
                            toast("Paired with ${dev.name ?: dev.address} — connecting")
                            refreshPaired()
                            HidKeyboard.connect(dev)
                        }
                    }
                }
            }
        }
        val filter = IntentFilter().apply {
            addAction(BluetoothDevice.ACTION_FOUND)
            addAction(BluetoothAdapter.ACTION_DISCOVERY_FINISHED)
            addAction(BluetoothDevice.ACTION_BOND_STATE_CHANGED)
        }
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(r, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("DEPRECATION")
            registerReceiver(r, filter)
        }
        receiver = r
    }

    private fun findDevice(intent: Intent): BluetoothDevice? =
        if (Build.VERSION.SDK_INT >= 33) {
            intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE, BluetoothDevice::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE)
        }

    private fun unregisterDiscovery() {
        val r = receiver ?: return
        receiver = null
        try {
            unregisterReceiver(r)
        } catch (e: IllegalArgumentException) {
            /* not registered */
        }
        try {
            btAdapter?.cancelDiscovery()
        } catch (e: SecurityException) {
            /* ignore */
        }
    }

    private fun toast(msg: String) {
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
    }

    // ---------- keyboard UI ----------

    private data class KeySpec(
        val label: String,
        val action: () -> Unit,
        val repeatable: Boolean = false,
        val accent: Boolean = false,
    )

    /** Display label for a character key, honouring shift/caps for letters. */
    private fun charLabel(c: Char): String {
        if (c in 'a'..'z' && (shift || caps)) return c.uppercaseChar().toString()
        return c.toString()
    }

    private fun charKey(c: Char) = KeySpec(charLabel(c), { pressChar(c) })

    private fun shiftSpec() = KeySpec(if (shift || caps) "⇧*" else "⇧", ::toggleShift, accent = shift || caps)

    private fun letterRows(): List<List<KeySpec>> = listOf(
        "1234567890".map { charKey(it) },
        "qwertyuiop".map { charKey(it) },
        "asdfghjkl".map { charKey(it) },
        listOf(shiftSpec()) + "zxcvbnm".map { charKey(it) } +
            listOf(charKey(','), charKey('.'), KeySpec("⌫", { pressSpecial("Backspace") }, repeatable = true)),
    )

    private fun symbolRows(): List<List<KeySpec>> = listOf(
        "1234567890".map { charKey(it) },
        "!@#$%^&*()".map { charKey(it) },
        "`~-_=+[]{}".map { charKey(it) },
        "\\|;:'\",<.>/?".map { charKey(it) },
    )

    private fun makeButton(spec: KeySpec): Button {
        val b = Button(this)
        b.text = spec.label
        b.textSize = 15f
        b.isAllCaps = false
        b.setPadding(0, 6, 0, 6)
        b.minHeight = 0
        b.minimumHeight = 0
        if (spec.accent) b.setBackgroundColor(Color.parseColor("#22D3EE"))
        if (spec.repeatable) {
            b.setOnTouchListener { _, event ->
                when (event.actionMasked) {
                    MotionEvent.ACTION_DOWN -> {
                        spec.action()
                        val runnable = object : Runnable {
                            override fun run() {
                                spec.action()
                                handler.postDelayed(this, 60)
                            }
                        }
                        b.setTag(R.id.repeat_tag, runnable)
                        handler.postDelayed(runnable, 450)
                        true
                    }
                    MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                        val r = b.getTag(R.id.repeat_tag) as? Runnable
                        if (r != null) handler.removeCallbacks(r)
                        false
                    }
                    else -> false
                }
            }
        } else {
            b.setOnClickListener { spec.action() }
        }
        return b
    }

    private fun addRow(specs: List<KeySpec>) {
        val row = LinearLayout(this)
        row.orientation = LinearLayout.HORIZONTAL
        row.gravity = Gravity.CENTER
        for (spec in specs) {
            row.addView(
                makeButton(spec),
                LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f),
            )
        }
        keyboardHost.addView(row)
    }

    /** Send one character, applying the on-screen shift/caps rules. */
    private fun pressChar(c: Char) {
        var ch = c
        if (ch in 'a'..'z' && (shift || caps)) ch = ch.uppercaseChar()
        val rep = HidUsage.charReport(ch)
        if (rep != null) HidKeyboard.tap(rep.second, rep.first)
        if (shift && ch in 'A'..'Z') {
            shift = false
            rebuildKeyboard()
        }
    }

    private fun pressSpecial(name: String) {
        val usage = HidUsage.specialUsage(name)
        if (usage != null) HidKeyboard.tap(0, usage)
    }

    private fun toggleShift() {
        val now = System.currentTimeMillis()
        if (shift && now - lastShiftTap < 300) {
            shift = false
            caps = !caps
        } else {
            shift = !shift
        }
        lastShiftTap = now
        rebuildKeyboard()
    }

    @SuppressLint("SetTextI18n")
    private fun buildKeyboard() {
        keyboardHost.removeAllViews()

        val rows = if (layerLetters) letterRows() else symbolRows()
        rows.forEach { addRow(it) }

        val bottom = mutableListOf(
            KeySpec(
                if (layerLetters) "?123" else "ABC",
                {
                    layerLetters = !layerLetters
                    buildKeyboard()
                },
            ),
            KeySpec("Space", { pressSpecial("Space") }, repeatable = true),
            KeySpec("Enter", { pressSpecial("Enter") }),
        )
        addRow(bottom)

        val nav = listOf(
            KeySpec("Esc", { pressSpecial("Escape") }),
            KeySpec("Tab", { pressSpecial("Tab") }),
            KeySpec("Home", { pressSpecial("Home") }),
            KeySpec("PgUp", { pressSpecial("PageUp") }),
            KeySpec("←", { pressSpecial("ArrowLeft") }, repeatable = true),
            KeySpec("↑", { pressSpecial("ArrowUp") }, repeatable = true),
            KeySpec("↓", { pressSpecial("ArrowDown") }, repeatable = true),
            KeySpec("→", { pressSpecial("ArrowRight") }, repeatable = true),
            KeySpec("End", { pressSpecial("End") }),
            KeySpec("PgDn", { pressSpecial("PageDown") }),
            KeySpec("Del", { pressSpecial("Delete") }, repeatable = true),
        )
        addRow(nav)
    }

    private fun rebuildKeyboard() {
        buildKeyboard()
        keyboardHost.scrollTo(0, 0)
    }

    // ---------- wifi remote mode (laptop types into this phone) ----------

    private val wifiStateListener: (String) -> Unit = { s ->
        runOnUiThread {
            tvWifiStatus.text = s
            btnWifiConnect.text =
                if (WifiRemote.connected) getString(R.string.btn_wifi_disconnect) else getString(R.string.btn_wifi_connect)
        }
    }

    private fun setupWifiMode() {
        btnModeBt = findViewById(R.id.btnModeBt)
        btnModeWifi = findViewById(R.id.btnModeWifi)
        btPanel = findViewById(R.id.btPanel)
        wifiPanel = findViewById(R.id.wifiPanel)
        tvWifiStatus = findViewById(R.id.tvWifiStatus)
        etWifiHost = findViewById(R.id.etWifiHost)
        etWifiPort = findViewById(R.id.etWifiPort)
        etWifiPin = findViewById(R.id.etWifiPin)
        btnWifiConnect = findViewById(R.id.btnWifiConnect)

        btnModeBt.setOnClickListener { setMode(wifi = false) }
        btnModeWifi.setOnClickListener { setMode(wifi = true) }

        val prefs = WifiRemote.settings(this)
        etWifiHost.setText(prefs.getString(WifiRemote.KEY_HOST, ""))
        etWifiPort.setText(prefs.getInt(WifiRemote.KEY_PORT, 8030).toString())
        etWifiPin.setText(prefs.getString(WifiRemote.KEY_PIN, ""))

        btnWifiConnect.setOnClickListener {
            if (WifiRemote.connected) {
                WifiRemote.disconnect()
                return@setOnClickListener
            }
            val host = etWifiHost.text.toString().trim()
            val port = etWifiPort.text.toString().toIntOrNull() ?: 8030
            val pin = etWifiPin.text.toString().trim()
            if (host.isEmpty() || pin.isEmpty()) {
                tvWifiStatus.text = getString(R.string.wifi_missing)
                return@setOnClickListener
            }
            WifiRemote.saveSettings(this, host, port, pin)
            WifiRemote.connect(this)
        }

        findViewById<Button>(R.id.btnWifiSettings).setOnClickListener {
            startActivity(Intent(Settings.ACTION_INPUT_METHOD_SETTINGS))
        }
        findViewById<Button>(R.id.btnWifiAccessibility).setOnClickListener {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        }

        WifiRemote.addStateListener(wifiStateListener)
        setMode(wifi = false)
    }

    private fun setMode(wifi: Boolean) {
        btPanel.visibility = if (wifi) View.GONE else View.VISIBLE
        wifiPanel.visibility = if (wifi) View.VISIBLE else View.GONE
        btnModeBt.isEnabled = wifi
        btnModeWifi.isEnabled = !wifi
        if (wifi && tvWifiStatus.text.isNullOrEmpty()) {
            tvWifiStatus.text = getString(R.string.wifi_status_idle)
        }
    }
}
