package com.chatoutline.mobile.fill

/** `{{变量名}}` 语法：同名变量只问一次。用字符串扫描代替正则，避免不同 Android 版本的正则引擎差异。 */
object Variables {
    private class Span(val start: Int, val end: Int, val name: String)

    private fun spans(content: String): List<Span> {
        val result = mutableListOf<Span>()
        var from = 0
        while (true) {
            val start = content.indexOf("{{", from)
            if (start < 0) break
            val close = content.indexOf("}}", start + 2)
            if (close < 0) break
            val raw = content.substring(start + 2, close)
            if (raw.isBlank() || raw.contains('{') || raw.contains('}') || raw.contains('\n')) {
                from = start + 1
                continue
            }
            result += Span(start, close + 2, raw.trim())
            from = close + 2
        }
        return result
    }

    /** 按出现顺序返回不重复的变量名。 */
    fun namesIn(content: String): List<String> = spans(content).map { it.name }.distinct()

    fun render(content: String, values: Map<String, String>): String {
        val sb = StringBuilder()
        var pos = 0
        for (span in spans(content)) {
            sb.append(content, pos, span.start)
            sb.append(values[span.name] ?: content.substring(span.start, span.end))
            pos = span.end
        }
        sb.append(content, pos, content.length)
        return sb.toString()
    }
}