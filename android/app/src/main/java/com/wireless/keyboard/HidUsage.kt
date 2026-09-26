package com.wireless.keyboard

/**
 * USB HID keyboard usage IDs (boot-keyboard report, US layout).
 * Usage page 0x07. Modifiers live in the first report byte.
 */
object HidUsage {

    const val MOD_LEFT_CTRL = 0x01
    const val MOD_LEFT_SHIFT = 0x02
    const val MOD_LEFT_ALT = 0x04
    const val MOD_LEFT_GUI = 0x08

    // a-z -> usage 4..29
    private val LETTERS = mapOf(
        'a' to 4, 'b' to 5, 'c' to 6, 'd' to 7, 'e' to 8, 'f' to 9, 'g' to 10,
        'h' to 11, 'i' to 12, 'j' to 13, 'k' to 14, 'l' to 15, 'm' to 16, 'n' to 17,
        'o' to 18, 'p' to 19, 'q' to 20, 'r' to 21, 's' to 22, 't' to 23, 'u' to 24,
        'v' to 25, 'w' to 26, 'x' to 27, 'y' to 28, 'z' to 29,
    )

    // digits -> usage 30..39
    private val DIGITS = mapOf(
        '1' to 30, '2' to 31, '3' to 32, '4' to 33, '5' to 34,
        '6' to 35, '7' to 36, '8' to 37, '9' to 38, '0' to 39,
    )

    // characters typed without a modifier
    private val PLAIN = mapOf(
        ' ' to 44, '-' to 45, '=' to 46, '[' to 47, ']' to 48, '\\' to 49,
        ';' to 51, '\'' to 52, '`' to 53, ',' to 54, '.' to 55, '/' to 56,
    )

    // characters typed with shift held
    private val SHIFTED = mapOf(
        '!' to 30, '@' to 31, '#' to 32, '$' to 33, '%' to 34, '^' to 35, '&' to 36,
        '*' to 37, '(' to 38, ')' to 39, '_' to 45, '+' to 46, '{' to 47, '}' to 48,
        '|' to 49, ':' to 51, '"' to 52, '~' to 53, '<' to 54, '>' to 55, '?' to 56,
    )

    const val USAGE_ENTER = 40
    const val USAGE_ESCAPE = 41
    const val USAGE_BACKSPACE = 42
    const val USAGE_TAB = 43
    const val USAGE_SPACE = 44
    const val USAGE_CAPS_LOCK = 57
    const val USAGE_INSERT = 73
    const val USAGE_HOME = 74
    const val USAGE_PAGE_UP = 75
    const val USAGE_DELETE = 76
    const val USAGE_END = 77
    const val USAGE_PAGE_DOWN = 78
    const val USAGE_RIGHT = 79
    const val USAGE_LEFT = 80
    const val USAGE_DOWN = 81
    const val USAGE_UP = 82

    /** Canonical-name -> usage, mirroring the web app's key names. */
    fun specialUsage(name: String): Int? = when (name) {
        "Enter" -> USAGE_ENTER
        "Escape" -> USAGE_ESCAPE
        "Backspace" -> USAGE_BACKSPACE
        "Tab" -> USAGE_TAB
        "Space" -> USAGE_SPACE
        "CapsLock" -> USAGE_CAPS_LOCK
        "Insert" -> USAGE_INSERT
        "Delete" -> USAGE_DELETE
        "Home" -> USAGE_HOME
        "End" -> USAGE_END
        "PageUp" -> USAGE_PAGE_UP
        "PageDown" -> USAGE_PAGE_DOWN
        "ArrowUp" -> USAGE_UP
        "ArrowDown" -> USAGE_DOWN
        "ArrowLeft" -> USAGE_LEFT
        "ArrowRight" -> USAGE_RIGHT
        "F1" -> 58
        "F2" -> 59
        "F3" -> 60
        "F4" -> 61
        "F5" -> 62
        "F6" -> 63
        "F7" -> 64
        "F8" -> 65
        "F9" -> 66
        "F10" -> 67
        "F11" -> 68
        "F12" -> 69
        else -> null
    }

    /**
     * Resolve the target character to (usage, modifier flags).
     * Uppercase letters and shifted symbols embed the shift bit, matching how a
     * desktop keyboard behaves when Shift is held for a single key.
     */
    fun charReport(c: Char): Pair<Int, Int>? {
        val lower = c.lowercaseChar()
        LETTERS[lower]?.let { usage ->
            val mods = if (c.isUpperCase()) MOD_LEFT_SHIFT else 0
            return usage to mods
        }
        DIGITS[c]?.let { return it to 0 }
        PLAIN[c]?.let { return it to 0 }
        SHIFTED[c]?.let { return it to MOD_LEFT_SHIFT }
        return when (c) {
            '\n', '\r' -> USAGE_ENTER to 0
            '\b' -> USAGE_BACKSPACE to 0
            '\t' -> USAGE_TAB to 0
            else -> null
        }
    }
}
