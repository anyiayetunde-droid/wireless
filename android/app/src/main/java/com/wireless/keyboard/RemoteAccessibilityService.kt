package com.wireless.keyboard

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.view.accessibility.AccessibilityEvent
import org.json.JSONObject

/**
 * Turns laptop-sent actions into real phone input:
 *   {t:'nav', a:'back'|'home'|'recents'|'notifications'|'quick_settings'}
 *   {t:'phone', g:'tap', x, y}          - normalized 0..1 coordinates
 *   {t:'phone', g:'swipe', x0, y0, x1, y1}
 *   {t:'phone', g:'scroll', dy}
 *
 * Requires the user to enable this service in Accessibility settings.
 */
class RemoteAccessibilityService : AccessibilityService() {

    private val msgListener: (JSONObject) -> Unit = ::onRemote

    override fun onServiceConnected() {
        super.onServiceConnected()
        WifiRemote.addListener(msgListener)
        WifiRemote.connectIfConfigured(applicationContext)
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // No window content is needed; gestures and global actions only.
    }

    override fun onInterrupt() {}

    override fun onDestroy() {
        WifiRemote.removeListener(msgListener)
        super.onDestroy()
    }

    private fun onRemote(msg: JSONObject) {
        when (msg.optString("t")) {
            "nav" -> handleNav(msg)
            "phone" -> handleGesture(msg)
        }
    }

    private fun handleNav(msg: JSONObject) {
        val action = when (msg.optString("a")) {
            "back" -> GLOBAL_ACTION_BACK
            "home" -> GLOBAL_ACTION_HOME
            "recents" -> GLOBAL_ACTION_RECENTS
            "notifications" -> GLOBAL_ACTION_NOTIFICATIONS
            "quick_settings" -> GLOBAL_ACTION_QUICK_SETTINGS
            else -> return
        }
        performGlobalAction(action)
    }

    private fun handleGesture(msg: JSONObject) {
        when (msg.optString("g")) {
            "tap" -> gestureTap(msg)
            "swipe" -> gestureSwipe(msg)
            "scroll" -> gestureScroll(msg)
        }
    }

    private fun dispatch(stroke: GestureDescription.StrokeDescription) {
        val desc = GestureDescription.Builder().addStroke(stroke).build()
        dispatchGesture(desc, null, null)
    }

    private fun gestureTap(msg: JSONObject) {
        val (w, h) = screenSize()
        val x = (msg.optDouble("x", 0.5) * w).toFloat().coerceIn(0f, w.toFloat())
        val y = (msg.optDouble("y", 0.5) * h).toFloat().coerceIn(0f, h.toFloat())
        val p = Path().apply { moveTo(x, y) }
        dispatch(GestureDescription.StrokeDescription(p, 0, 60))
    }

    private fun gestureSwipe(msg: JSONObject) {
        val (w, h) = screenSize()
        val x0 = (msg.optDouble("x0", 0.5) * w).toFloat().coerceIn(0f, w.toFloat())
        val y0 = (msg.optDouble("y0", 0.5) * h).toFloat().coerceIn(0f, h.toFloat())
        val x1 = (msg.optDouble("x1", 0.5) * w).toFloat().coerceIn(0f, w.toFloat())
        val y1 = (msg.optDouble("y1", 0.5) * h).toFloat().coerceIn(0f, h.toFloat())
        val p = Path().apply {
            moveTo(x0, y0)
            lineTo(x1, y1)
        }
        dispatch(GestureDescription.StrokeDescription(p, 0, 150))
    }

    private fun gestureScroll(msg: JSONObject) {
        val (w, h) = screenSize()
        val dy = msg.optDouble("dy", 0.0)
        // Scroll down (dy > 0) == finger moves up on the phone screen.
        val x = (w / 2).toFloat()
        val y0 = (h * 0.62).toFloat()
        val y1 = (h * if (dy > 0) 0.30 else 0.94).toFloat()
        val p = Path().apply {
            moveTo(x, y0)
            lineTo(x, y1)
        }
        dispatch(GestureDescription.StrokeDescription(p, 0, 180))
    }

    private fun screenSize(): Pair<Float, Float> {
        val dm = resources.displayMetrics
        return dm.widthPixels.toFloat() to dm.heightPixels.toFloat()
    }
}