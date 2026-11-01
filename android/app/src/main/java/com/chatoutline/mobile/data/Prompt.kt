package com.chatoutline.mobile.data

import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale

/** 提示词，字段和扩展的 prompts.json 保持一致。 */
data class Prompt(
    val id: String,
    val title: String,
    val content: String,
    val tags: List<String>,
    val updatedAt: Long,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("id", id)
        .put("title", title)
        .put("content", content)
        .put("tags", JSONArray(tags))
        .put("updatedAt", updatedAt)

    companion object {
        fun fromJson(o: JSONObject): Prompt {
            val tagsArr = o.optJSONArray("tags") ?: JSONArray()
            return Prompt(
                id = o.getString("id"),
                title = o.optString("title", ""),
                content = o.optString("content", ""),
                tags = List(tagsArr.length()) { tagsArr.optString(it) },
                updatedAt = o.optLong("updatedAt", 0L),
            )
        }
    }
}

/** 删除记录：{id, deletedAt}，保留 180 天。 */
data class Tombstone(val id: String, val deletedAt: Long) {
    fun toJson(): JSONObject = JSONObject().put("id", id).put("deletedAt", deletedAt)

    companion object {
        fun fromJson(o: JSONObject) = Tombstone(o.getString("id"), o.optLong("deletedAt", 0L))
    }
}

/** 和扩展一样的 id：毫秒时间戳（36 进制）加随机串。 */
fun newPromptId(): String {
    val chars = "abcdefghijklmnopqrstuvwxyz0123456789"
    val rnd = buildString { repeat(5) { append(chars[(Math.random() * chars.length).toInt()]) } }
    return System.currentTimeMillis().toString(36).lowercase(Locale.ROOT) + rnd
}
