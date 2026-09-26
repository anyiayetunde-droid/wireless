package com.wireless.keyboard

import android.content.Context
import android.content.SharedPreferences
import android.os.Handler
import android.os.Looper
import android.util.Log
import org.json.JSONObject
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Shared WiFi-remote connection: the IME and the accessibility service both
 * subscribe. The server address + PIN live in SharedPreferences; the phone
 * connects as a "receiver" so the laptop page can type into it.
 */
object WifiRemote {

    private const val TAG = "WifiRemote"
    const val PREFS = "wifi_remote"
    const val KEY_HOST = "host"
    const val KEY_PORT = "port"
    const val KEY_PIN = "pin"

    private data class Config(val host: String, val port: Int, val pin: String)

    private val listeners = CopyOnWriteArrayList<(JSONObject) -> Unit>()
    private val stateListeners = CopyOnWriteArrayList<(String) -> Unit>()

    @Volatile
    var connected = false
        private set

    private var client: WifiClient? = null
    private var config: Config? = null
    private var shouldRun = false
    private val main = Handler(Looper.getMainLooper())
    private var pingTimer: Runnable? = null
    private var reconnectTimer: Runnable? = null

    fun addListener(l: (JSONObject) -> Unit) = listeners.add(l)
    fun removeListener(l: (JSONObject) -> Unit) = listeners.remove(l)
    fun addStateListener(l: (String) -> Unit) = stateListeners.add(l)
    fun removeStateListener(l: (String) -> Unit) = stateListeners.remove(l)

    fun settings(context: Context): SharedPreferences =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun saveSettings(context: Context, host: String, port: Int, pin: String) {
        settings(context).edit()
            .putString(KEY_HOST, host.trim())
            .putInt(KEY_PORT, port)
            .putString(KEY_PIN, pin.trim())
            .apply()
    }

    fun isConfigured(context: Context): Boolean {
        val s = settings(context)
        return !s.getString(KEY_HOST, "").isNullOrBlank() && !s.getString(KEY_PIN, "").isNullOrBlank()
    }

    /** Connects when saved settings exist; otherwise just reports state. */
    fun connectIfConfigured(context: Context) {
        val s = settings(context)
        val host = s.getString(KEY_HOST, "") ?: ""
        val pin = s.getString(KEY_PIN, "") ?: ""
        if (host.isBlank() || pin.isBlank()) {
            setState("WiFi Remote not configured — open the app and enter your computer's address")
            return
        }
        connect(context)
    }

    @Synchronized
    fun connect(context: Context) {
        val s = settings(context)
        val host = s.getString(KEY_HOST, "") ?: ""
        val pin = s.getString(KEY_PIN, "") ?: ""
        val port = s.getInt(KEY_PORT, 8030)
        if (host.isBlank() || pin.isBlank()) {
            setState("Enter your computer's address and PIN first")
            return
        }
        if (shouldRun) return // already connected or reconnecting
        startWith(Config(host, port, pin))
    }

    @Synchronized
    fun disconnect() {
        shouldRun = false
        connected = false
        stopPings()
        cancelReconnect()
        client?.stop()
        client = null
        config = null
        setState("Disconnected")
    }

    private fun startWith(cfg: Config) {
        stopPings()
        cancelReconnect()
        client?.stop()
        config = cfg
        shouldRun = true
        connected = false
        setState("Connecting to ${cfg.host}:${cfg.port}…")
        startClient(cfg)
    }

    private fun startClient(cfg: Config) {
        val c = WifiClient(
            host = cfg.host,
            port = cfg.port,
            onReady = {
                // client is assigned before start() connects, so it's safe here.
                client?.send(JSONObject().put("t", "hello").put("pin", cfg.pin).put("role", "receiver"))
                startPings()
            },
            onMessage = ::dispatch,
            onClosed = { reason -> handleClosed(reason) },
        )
        client = c
        c.start()
    }

    private fun handleClosed(reason: String) {
        connected = false
        stopPings()
        if (reason.contains("replaced")) {
            // Another device took the receiver role — stop fighting over it.
            shouldRun = false
            setState("Connected elsewhere — another device is the receiver")
            return
        }
        if (shouldRun) {
            setState("Disconnected ($reason) — reconnecting…")
            scheduleReconnect()
        } else {
            setState("Disconnected")
        }
    }

    private fun scheduleReconnect() {
        cancelReconnect()
        val cfg = config ?: return
        val r = Runnable { startClient(cfg) }
        reconnectTimer = r
        main.postDelayed(r, 3000)
    }

    private fun cancelReconnect() {
        reconnectTimer?.let { main.removeCallbacks(it) }
        reconnectTimer = null
    }

    private fun startPings() {
        stopPings()
        val r = object : Runnable {
            override fun run() {
                client?.send(JSONObject().put("t", "ping"))
                pingTimer = this
                main.postDelayed(this, 25000)
            }
        }
        pingTimer = r
        main.postDelayed(r, 25000)
    }

    private fun stopPings() {
        pingTimer?.let { main.removeCallbacks(it) }
        pingTimer = null
    }

    private fun dispatch(msg: JSONObject) {
        if (msg.optString("t") == "welcome") {
            val ok = msg.optBoolean("ok", false)
            connected = ok
            setState(if (ok) "Connected — type from the laptop page" else msg.optString("msg", "Rejected by server"))
            return
        }
        val m = msg
        main.post {
            for (l in listeners) {
                try {
                    l(m)
                } catch (e: Exception) {
                    Log.e(TAG, "listener error", e)
                }
            }
        }
    }

    private fun setState(text: String) {
        main.post {
            for (l in stateListeners) {
                try {
                    l(text)
                } catch (e: Exception) {
                    Log.e(TAG, "state listener error", e)
                }
            }
        }
    }
}