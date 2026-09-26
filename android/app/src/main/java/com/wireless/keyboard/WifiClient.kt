package com.wireless.keyboard

import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.EOFException
import java.io.IOException
import java.net.InetSocketAddress
import java.net.Socket
import java.security.SecureRandom
import java.util.Base64
import java.util.concurrent.atomic.AtomicBoolean

/**
 * A minimal RFC 6455 WebSocket client with zero dependencies. Only text frames
 * are supported. The reader runs on its own thread; [onMessage] and [onClosed]
 * are invoked from that thread, [onReady] right after the handshake completes.
 */
class WifiClient(
    private val host: String,
    private val port: Int,
    private val onReady: () -> Unit,
    private val onMessage: (JSONObject) -> Unit,
    private val onClosed: (String) -> Unit,
) {
    private val random = SecureRandom()
    private val running = AtomicBoolean(false)
    private val stopped = AtomicBoolean(false)
    private var socket: Socket? = null
    private var out: DataOutputStream? = null

    fun start() {
        if (!running.compareAndSet(false, true)) return
        Thread({ run() }, "wifi-ws").start()
    }

    /** Stops the connection; [onClosed] is NOT called. */
    fun stop() {
        stopped.set(true)
        running.set(false)
        closeSocket()
    }

    fun send(obj: JSONObject) = writeFrame(0x1, obj.toString().toByteArray(Charsets.UTF_8))

    private fun run() {
        var reason = "connection closed"
        try {
            if (!running.get()) return
            val sock = Socket()
            sock.connect(InetSocketAddress(host, port), 8000)
            // A quiet-but-alive connection would block forever; the keep-alive
            // pings (every 25s) reset this timeout.
            sock.soTimeout = 35000
            socket = sock
            val input = DataInputStream(BufferedInputStream(sock.getInputStream()))
            val output = DataOutputStream(BufferedOutputStream(sock.getOutputStream()))
            out = output
            handshake(input, output)
            onReady()
            while (running.get()) {
                val frame = readFrame(input) ?: break
                when (frame.opcode) {
                    0x1 -> onMessage(JSONObject(frame.text))
                    0x9 -> writeFrame(0xA, frame.payload) // pong
                    0x8 -> {
                        reason = if (frame.text.isNotEmpty()) "closed by server: ${frame.text}" else "closed by server"
                        break
                    }
                }
            }
        } catch (e: EOFException) {
            reason = "server went away"
        } catch (e: IOException) {
            if (!stopped.get()) reason = e.message ?: "network error"
        } catch (e: Exception) {
            if (!stopped.get()) reason = e.message ?: "connection error"
        } finally {
            running.set(false)
            closeSocket()
            if (!stopped.get()) onClosed(reason)
        }
    }

    private fun handshake(input: DataInputStream, output: DataOutputStream) {
        val keyBytes = ByteArray(16).also { random.nextBytes(it) }
        val key = Base64.getEncoder().encodeToString(keyBytes)
        val request = buildString {
            append("GET /ws HTTP/1.1\r\n")
            append("Host: $host:$port\r\n")
            append("Upgrade: websocket\r\n")
            append("Connection: Upgrade\r\n")
            append("Sec-WebSocket-Key: $key\r\n")
            append("Sec-WebSocket-Version: 13\r\n")
            append("\r\n")
        }
        output.write(request.toByteArray(Charsets.UTF_8))
        output.flush()

        val status = readLine(input) ?: throw IOException("no handshake response")
        if (!status.startsWith("HTTP/1.1 101")) throw IOException("handshake rejected: $status")
        // consume the remaining headers
        while (true) {
            val line = readLine(input) ?: break
            if (line.isEmpty()) break
        }
    }

    private fun readLine(input: DataInputStream): String? {
        val sb = StringBuilder()
        while (true) {
            val b = input.read()
            if (b < 0) return if (sb.isEmpty()) null else sb.toString()
            if (b == '\n'.code) return sb.toString().removeSuffix("\r")
            sb.append(b.toChar())
        }
    }

    private class Frame(val opcode: Int, val payload: ByteArray, val text: String)

    private fun readFrame(input: DataInputStream): Frame? {
        val b0 = input.read()
        if (b0 < 0) return null
        val b1 = input.read()
        if (b1 < 0) return null
        val opcode = b0 and 0x0f
        var len = b1 and 0x7f
        if (len == 126) {
            len = (input.read() shl 8) or input.read()
        } else if (len == 127) {
            var l = 0L
            for (i in 0 until 8) l = (l shl 8) or input.read().toLong()
            len = l.toInt()
        }
        val masked = (b1 and 0x80) != 0
        val mask = ByteArray(4)
        if (masked) input.readFully(mask)
        val payload = ByteArray(len)
        input.readFully(payload)
        if (masked) {
            for (i in payload.indices) payload[i] = (payload[i].toInt() xor mask[i % 4].toInt()).toByte()
        }
        val text = if (opcode == 0x1) String(payload, Charsets.UTF_8) else ""
        return Frame(opcode, payload, text)
    }

    private fun writeFrame(opcode: Int, payload: ByteArray) {
        val o = out ?: return
        synchronized(o) {
            val mask = ByteArray(4).also { random.nextBytes(it) }
            val header = ByteArray(if (payload.size < 126) 2 else if (payload.size < 65536) 4 else 10)
            header[0] = (0x80 or opcode).toByte()
            when {
                payload.size < 126 -> header[1] = (0x80 or payload.size).toByte()
                payload.size < 65536 -> {
                    header[1] = (0x80 or 126).toByte()
                    header[2] = (payload.size shr 8).toByte()
                    header[3] = payload.size.toByte()
                }
                else -> {
                    header[1] = (0x80 or 127).toByte()
                    var l = payload.size.toLong()
                    for (i in 8 downTo 1) {
                        header[1 + i] = (l and 0xff).toByte()
                        l = l shr 8
                    }
                }
            }
            val body = ByteArray(payload.size)
            for (i in payload.indices) body[i] = (payload[i].toInt() xor mask[i % 4].toInt()).toByte()
            o.write(header)
            o.write(mask)
            o.write(body)
            o.flush()
        }
    }

    private fun closeSocket() {
        try {
            socket?.close()
        } catch (_: IOException) {
            /* ignore */
        }
        socket = null
        out = null
    }
}