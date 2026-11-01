package com.chatoutline.mobile.data

import android.content.Context
import com.chatoutline.mobile.sync.TOMBSTONE_KEEP_MS
import com.chatoutline.mobile.sync.SyncData
import com.chatoutline.mobile.sync.WebDavSync
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

/** 提示词和同步设置的唯一入口。界面和悬浮窗都从这里读取，数据变化通过 StateFlow 通知。 */
object PromptRepository {
    private const val PREFS = "chat_outline"
    private const val KEY_PROMPTS = "prompts"
    private const val KEY_TOMBSTONES = "tombstones"
    private const val KEY_VAR_MEMORY = "var_memory"
    private const val KEY_SYNC_URL = "sync_url"
    private const val KEY_SYNC_USER = "sync_user"
    private const val KEY_SYNC_LABEL = "sync_label"
    private const val KEY_SYNC_PASS = "sync_pass"
    private const val KEY_SYNC_STATUS = "sync_status"
    private const val KEY_SYNC_AT = "sync_at"
    const val DEFAULT_SYNC_URL = "https://dav.jianguoyun.com/dav/"

    private lateinit var prefs: android.content.SharedPreferences
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var pushJob: Job? = null

    private val _prompts = MutableStateFlow<List<Prompt>>(emptyList())
    val prompts: StateFlow<List<Prompt>> = _prompts.asStateFlow()

    private val _syncStatus = MutableStateFlow("未同步")
    val syncStatus: StateFlow<String> = _syncStatus.asStateFlow()

    private val _syncing = MutableStateFlow(false)
    val syncing: StateFlow<Boolean> = _syncing.asStateFlow()

    private var tombstones: List<Tombstone> = emptyList()

    fun init(context: Context) {
        if (::prefs.isInitialized) return
        prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        _prompts.value = readPrompts(prefs.getString(KEY_PROMPTS, null))
        tombstones = readTombstones(prefs.getString(KEY_TOMBSTONES, null))
        _syncStatus.value = prefs.getString(KEY_SYNC_STATUS, null) ?: "未同步"
    }

    // 增删改

    fun save(prompt: Prompt) {
        val now = System.currentTimeMillis()
        val stamped = prompt.copy(updatedAt = now)
        val list = _prompts.value.filterNot { it.id == stamped.id } + stamped
        // 同一 id 重新编辑时，如果之前删过，删除记录要去掉，否则新内容会被旧删除吃掉
        tombstones = tombstones.filterNot { it.id == stamped.id }
        commit(list.sortedBy { it.title }, tombstones)
    }

    fun delete(id: String) {
        val list = _prompts.value.filterNot { it.id == id }
        tombstones = tombstones.filterNot { it.id == id } + Tombstone(id, System.currentTimeMillis())
        commit(list, tombstones)
    }

    private fun commit(list: List<Prompt>, deleted: List<Tombstone>) {
        _prompts.value = list
        tombstones = deleted
        prefs.edit()
            .putString(KEY_PROMPTS, JSONArray(list.map { it.toJson() }).toString())
            .putString(KEY_TOMBSTONES, JSONArray(deleted.map { it.toJson() }).toString())
            .apply()
        schedulePush()
    }

    /** 同步合并后写回本地，不触发再次推送。 */
    fun applyMerged(data: SyncData) {
        _prompts.value = data.prompts.sortedBy { it.title }
        tombstones = data.tombstones
        prefs.edit()
            .putString(KEY_PROMPTS, JSONArray(data.prompts.map { it.toJson() }).toString())
            .putString(KEY_TOMBSTONES, JSONArray(data.tombstones.map { it.toJson() }).toString())
            .apply()
    }

    fun localData(): SyncData = SyncData(_prompts.value, tombstones)

    fun pruneOldTombstones(now: Long = System.currentTimeMillis()) {
        tombstones = tombstones.filter { now - it.deletedAt <= TOMBSTONE_KEEP_MS }
    }

    // 修改后几秒推送，和扩展保持一致

    private fun schedulePush() {
        if (syncConfig() == null) return
        pushJob?.cancel()
        pushJob = scope.launch {
            delay(3_000)
            sync()
        }
    }

    // 同步设置

    data class SyncConfig(val url: String, val user: String, val pass: String)

    fun syncConfig(): SyncConfig? {
        val user = prefs.getString(KEY_SYNC_USER, null)?.takeIf { it.isNotBlank() } ?: return null
        val encrypted = prefs.getString(KEY_SYNC_PASS, null) ?: return null
        val pass = Secrets.decrypt(encrypted) ?: return null
        val url = prefs.getString(KEY_SYNC_URL, null)?.takeIf { it.isNotBlank() } ?: DEFAULT_SYNC_URL
        return SyncConfig(url, user, pass)
    }

    /** 设置页回显用。应用名称只保存在本机，不写入网盘文件，也不影响同步。 */
    data class SavedSyncFields(val url: String, val label: String, val user: String, val hasPassword: Boolean)

    fun savedSyncFields(): SavedSyncFields = SavedSyncFields(
        url = prefs.getString(KEY_SYNC_URL, null) ?: DEFAULT_SYNC_URL,
        label = prefs.getString(KEY_SYNC_LABEL, null) ?: "",
        user = prefs.getString(KEY_SYNC_USER, null) ?: "",
        hasPassword = prefs.contains(KEY_SYNC_PASS),
    )

    fun saveSyncConfig(url: String, label: String, user: String, pass: String?) {
        val edit = prefs.edit()
            .putString(KEY_SYNC_URL, url.trim().ifBlank { DEFAULT_SYNC_URL })
            .putString(KEY_SYNC_LABEL, label.trim())
            .putString(KEY_SYNC_USER, user.trim())
        // 密码留空表示不修改
        if (!pass.isNullOrEmpty()) edit.putString(KEY_SYNC_PASS, Secrets.encrypt(pass))
        edit.apply()
    }

    fun clearSyncConfig() {
        prefs.edit().remove(KEY_SYNC_URL).remove(KEY_SYNC_LABEL).remove(KEY_SYNC_USER).remove(KEY_SYNC_PASS).apply()
    }

    /** 手动或自动同步。返回 true 表示成功。 */
    suspend fun sync(): Boolean {
        val result = WebDavSync.run()
        setStatus(result.message)
        if (result.ok) prefs.edit().putLong(KEY_SYNC_AT, System.currentTimeMillis()).apply()
        return result.ok
    }

    fun lastSyncAt(): Long = prefs.getLong(KEY_SYNC_AT, 0L)

    fun setSyncing(on: Boolean) {
        _syncing.value = on
    }

    fun setStatus(text: String) {
        _syncStatus.value = text
        prefs.edit().putString(KEY_SYNC_STATUS, text).apply()
    }

    // 变量记忆：同名变量记住上次的值

    fun rememberedVariables(): Map<String, String> {
        val obj = runCatching { JSONObject(prefs.getString(KEY_VAR_MEMORY, "{}") ?: "{}") }.getOrNull()
            ?: return emptyMap()
        return obj.keys().asSequence().associateWith { obj.getString(it) }
    }

    fun rememberVariables(values: Map<String, String>) {
        val merged = rememberedVariables() + values
        prefs.edit().putString(KEY_VAR_MEMORY, JSONObject(merged as Map<*, *>).toString()).apply()
    }

    private fun readPrompts(raw: String?): List<Prompt> {
        if (raw == null) return emptyList()
        val arr = runCatching { JSONArray(raw) }.getOrNull() ?: return emptyList()
        return List(arr.length()) { Prompt.fromJson(arr.getJSONObject(it)) }
    }

    private fun readTombstones(raw: String?): List<Tombstone> {
        if (raw == null) return emptyList()
        val arr = runCatching { JSONArray(raw) }.getOrNull() ?: return emptyList()
        return List(arr.length()) { Tombstone.fromJson(arr.getJSONObject(it)) }
    }
}
