package com.chatoutline.mobile.sync

import com.chatoutline.mobile.data.Prompt
import com.chatoutline.mobile.data.Tombstone

/** 删除记录保留 180 天，和扩展一致。 */
const val TOMBSTONE_KEEP_MS = 180L * 24 * 3600 * 1000

data class SyncData(val prompts: List<Prompt>, val tombstones: List<Tombstone>)

/**
 * 按修改时间合并，较新的优先；删除记录比提示词新时删除生效。
 * 与 background.js 的 mergeData 保持同样的规则，两端合并结果必须一致。
 */
fun mergeData(a: SyncData, b: SyncData, now: Long = System.currentTimeMillis()): SyncData {
    val deleted = HashMap<String, Long>()
    for (t in a.tombstones + b.tombstones) {
        if (now - t.deletedAt > TOMBSTONE_KEEP_MS) continue
        if ((deleted[t.id] ?: 0L) < t.deletedAt) deleted[t.id] = t.deletedAt
    }
    val prompts = LinkedHashMap<String, Prompt>()
    for (p in a.prompts + b.prompts) {
        val cur = prompts[p.id]
        if (cur == null || p.updatedAt > cur.updatedAt) prompts[p.id] = p
    }
    for ((id, p) in prompts.entries.toList()) {
        val deletedAt = deleted[id] ?: continue
        if (p.updatedAt > deletedAt) deleted.remove(id) else prompts.remove(id)
    }
    return SyncData(
        prompts = prompts.values.toList(),
        tombstones = deleted.map { (id, at) -> Tombstone(id, at) },
    )
}

/** 用于判断内容是否变化，排序后比较，避免顺序不同造成误判。 */
fun canonical(d: SyncData): String {
    val ps = d.prompts.sortedBy { it.id }.joinToString(",") { it.toJson().toString() }
    val ts = d.tombstones.sortedBy { it.id }.joinToString(",") { it.toJson().toString() }
    return "[$ps]|[$ts]"
}
