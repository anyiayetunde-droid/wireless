package com.wireless.keyboard

import android.content.Intent
import android.inputmethodservice.InputMethodService
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.Gravity
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.InputConnection
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONObject

/**
 * A custom keyboard ("IME") that receives keystrokes over WiFi from the laptop
 * page and types them into whatever field has focus on the phone.
 *
 * The laptop page sends:
 *   {t:'key', k}                     - single tap (character or special key)
 *   {t:'keydown'/'keyup', k, mods}   - physical keyboard down/up
 *   {t:'combo', mods, k}             - shortcut combos like Ctrl+C
 *   {t:'text', s}                    - a whole run of text
 */
class RemoteImeService : InputMethodService() {

    private val main = Handler(Looper.getMainLooper())
    private lateinit var tvStatus: TextView

    private val msgListener: (JSONObject) -> Unit = ::onRemote
    private val stateListener: (String) -> Unit = { s ->
        main.post {
            if (::tvStatus.isInitialized) tvStatus.text = s
        }
    }

    override fun onCreate() {
        super.onCreate()
        WifiRemote.addListener(msgListener)
        WifiRemote.addStateListener(stateListener)
        WifiRemote.connectIfConfigured(applicationContext)
    }

    override fun onDestroy() {
        WifiRemote.removeListener(msgListener)
        WifiRemote.removeStateListener(stateListener)
        super.onDestroy()
    }

    override fun onStartInputView(info: android.view.inputmethod.EditorInfo?, restarting: Boolean) {
        super.onStartInputView(info, restarting)
        // Retry connecting in case the server was reachable by now.
        if (!WifiRemote.connected) WifiRemote.connectIfConfigured(applicationContext)
    }

    override fun onCreateInputView(): View {
        val root = LinearLayout(this)
        root.orientation = LinearLayout.VERTICAL
        root.gravity = Gravity.CENTER
        root.setPadding(0, 24, 0, 24)

        tvStatus = TextView(this).apply {
            text = getString(R.string.ime_status_idle)
            setTextColor(0xFFE8E9EE.toInt())
            textSize = 16f
            gravity = Gravity.CENTER
            setPadding(16, 0, 16, 16)
        }
        val btn = Button(this).apply {
            text = "Open Wireless app"
            setOnClickListener {
                val i = Intent(this@RemoteImeService, MainActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                startActivity(i)
            }
        }
        root.addView(tvStatus)
        root.addView(btn)
        return root
    }

    // ---------- incoming messages ----------

    private fun onRemote(msg: JSONObject) {
        val ic = currentInputConnection ?: return
        when (msg.optString("t")) {
            "key" -> handleKey(ic, msg.optString("k"), emptyList(), tap = true)
            "keydown" -> handleKey(ic, msg.optString("k"), modsOf(msg), tap = false)
            "keyup" -> handleKey(ic, msg.optString("k"), modsOf(msg), tap = false, up = true)
            "combo" -> handleCombo(ic, msg)
            "text" -> ic.commitText(msg.optString("s", ""), 1)
        }
    }

    private fun modsOf(msg: JSONObject): List<String> {
        val arr = msg.optJSONArray("mods") ?: return emptyList()
        val out = ArrayList<String>(arr.length())
        for (i in 0 until arr.length()) out.add(arr.optString(i))
        return out
    }

    private fun handleKey(ic: InputConnection, k: String, mods: List<String>, tap: Boolean, up: Boolean = false) {
        if (k.isEmpty()) return
        if (k.length == 1 && keyCode(k) == null) {
            // Printable character — commit like an IME would.
            if (tap || !up) ic.commitText(k, 1)
            return
        }
        val code = keyCode(k) ?: return
        val meta = metaState(mods)
        val now = SystemClock.uptimeMillis()
        if (tap) {
            ic.sendKeyEvent(KeyEvent(now, now, KeyEvent.ACTION_DOWN, code, 0, meta))
            ic.sendKeyEvent(KeyEvent(now, now, KeyEvent.ACTION_UP, code, 0, meta))
        } else {
            val action = if (up) KeyEvent.ACTION_UP else KeyEvent.ACTION_DOWN
            ic.sendKeyEvent(KeyEvent(now, now, action, code, 0, meta))
        }
    }

    private fun handleCombo(ic: InputConnection, msg: JSONObject) {
        val mods = modsOf(msg)
        val k = msg.optString("k", "")
        if (k.isEmpty()) return
        val code = keyCode(k) ?: if (k.length == 1) keyCodeForChar(k[0]) else KeyEvent.KEYCODE_UNKNOWN
        if (code == 0 || code == KeyEvent.KEYCODE_UNKNOWN) return
        val meta = metaState(mods)
        val now = SystemClock.uptimeMillis()
        ic.sendKeyEvent(KeyEvent(now, now, KeyEvent.ACTION_DOWN, code, 0, meta))
        ic.sendKeyEvent(KeyEvent(now, now, KeyEvent.ACTION_UP, code, 0, meta))
    }

    private fun metaState(mods: List<String>): Int {
        var m = 0
        for (mod in mods) {
            m = when (mod) {
                "Shift" -> m or KeyEvent.META_SHIFT_ON
                "Control" -> m or KeyEvent.META_CTRL_ON
                "Alt" -> m or KeyEvent.META_ALT_ON
                "Super" -> m or KeyEvent.META_META_ON
                else -> m
            }
        }
        return m
    }

    /** Best-effort char -> keycode for simple combos (e.g. Ctrl+A). */
    private fun keyCodeForChar(c: Char): Int {
        val map = KeyCharacterMap.load(KeyCharacterMap.VIRTUAL_KEYBOARD)
        val lower = c.lowercaseChar()
        for (code in KeyEvent.KEYCODE_A..KeyEvent.KEYCODE_Z) {
            if (map.get(code, 0).toChar().lowercaseChar() == lower) return code
        }
        for (code in KeyEvent.KEYCODE_0..KeyEvent.KEYCODE_9) {
            if (map.get(code, 0).toChar() == c) return code
        }
        return KeyEvent.KEYCODE_UNKNOWN
    }

    /** Canonical key name -> Android keycode; null means "printable character". */
    private fun keyCode(name: String): Int? = when (name) {
        "Enter" -> KeyEvent.KEYCODE_ENTER
        "Backspace" -> KeyEvent.KEYCODE_DEL
        "Tab" -> KeyEvent.KEYCODE_TAB
        "Escape" -> KeyEvent.KEYCODE_ESCAPE
        "Delete" -> KeyEvent.KEYCODE_FORWARD_DEL
        "Insert" -> KeyEvent.KEYCODE_INSERT
        "Home" -> KeyEvent.KEYCODE_MOVE_HOME
        "End" -> KeyEvent.KEYCODE_MOVE_END
        "PageUp" -> KeyEvent.KEYCODE_PAGE_UP
        "PageDown" -> KeyEvent.KEYCODE_PAGE_DOWN
        "ArrowUp" -> KeyEvent.KEYCODE_DPAD_UP
        "ArrowDown" -> KeyEvent.KEYCODE_DPAD_DOWN
        "ArrowLeft" -> KeyEvent.KEYCODE_DPAD_LEFT
        "ArrowRight" -> KeyEvent.KEYCODE_DPAD_RIGHT
        "Space" -> KeyEvent.KEYCODE_SPACE
        "CapsLock" -> KeyEvent.KEYCODE_CAPS_LOCK
        "F1" -> KeyEvent.KEYCODE_F1
        "F2" -> KeyEvent.KEYCODE_F2
        "F3" -> KeyEvent.KEYCODE_F3
        "F4" -> KeyEvent.KEYCODE_F4
        "F5" -> KeyEvent.KEYCODE_F5
        "F6" -> KeyEvent.KEYCODE_F6
        "F7" -> KeyEvent.KEYCODE_F7
        "F8" -> KeyEvent.KEYCODE_F8
        "F9" -> KeyEvent.KEYCODE_F9
        "F10" -> KeyEvent.KEYCODE_F10
        "F11" -> KeyEvent.KEYCODE_F11
        "F12" -> KeyEvent.KEYCODE_F12
        else -> null
    }
}