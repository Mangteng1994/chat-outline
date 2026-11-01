package com.chatoutline.mobile.sync

import com.chatoutline.mobile.data.Prompt
import com.chatoutline.mobile.data.PromptRepository
import com.chatoutline.mobile.data.Tombstone
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.Credentials
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.util.concurrent.TimeUnit

/**
 * 坚果云等 WebDAV 上的 chat-outline/prompts.json 同步。
 * 规则与扩展的 background.js（syncOnce）一致，两端必须能互相读写。
 */
object WebDavSync {
    private const val FOLDER = "chat-outline/"
    private const val FILE = FOLDER + "prompts.json"
    private const val MAX_ATTEMPTS = 3
    private val JSON = "application/json".toMediaType()

    class Outcome(val ok: Boolean, val message: String)

    private class SyncError(message: String) : Exception(message)

    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    private val mutex = Mutex()

    suspend fun run(): Outcome = withContext(Dispatchers.IO) {
        mutex.withLock {
        val cfg = PromptRepository.syncConfig()
            ?: return@withLock Outcome(false, "还没有设置同步")
        PromptRepository.setSyncing(true)
        try {
            syncOnce(cfg)
            Outcome(true, "已同步 · " + nowText())
        } catch (e: SyncError) {
            Outcome(false, e.message ?: "同步失败")
        } catch (e: SocketTimeoutException) {
            Outcome(false, "连接网盘超时")
        } catch (e: UnknownHostException) {
            Outcome(false, "连不上网盘，请检查网络或地址")
        } catch (e: IOException) {
            Outcome(false, "连不上网盘，请检查网络或地址")
        } finally {
            PromptRepository.setSyncing(false)
        }
    } }

    private fun syncOnce(cfg: PromptRepository.SyncConfig) {
        val base = cfg.url.let { if (it.endsWith("/")) it else "$it/" }
        val auth = Credentials.basic(cfg.user, cfg.pass, Charsets.UTF_8)

        repeat(MAX_ATTEMPTS) {
            // 1. 读取网盘文件
            val remote: SyncData?
            val etag: String?
            get(base + FILE, auth).use { res ->
                // 坚果云在文件夹还不存在时返回 409，其他网盘一般返回 404
                if (res.code != 200 && res.code != 404 && res.code != 409) throw httpError(res.code)
                if (res.code == 200) {
                    val parsed = parseRemote(res.body?.string().orEmpty())
                        ?: throw SyncError("网盘里的同步文件已损坏")
                    remote = parsed
                    etag = res.header("ETag")
                } else {
                    remote = null
                    etag = null
                }
            }

            // 2. 合并到本地
            val local = PromptRepository.localData()
            val merged = mergeData(local, remote ?: SyncData(emptyList(), emptyList()))
            val pulled = canonical(merged) != canonical(local)
            if (pulled) PromptRepository.applyMerged(merged)
            if (remote != null && canonical(merged) == canonical(remote)) return

            // 3. 带防覆盖条件写回；网盘文件被其他设备改过时（412）重新读取合并
            val body = JSONObject()
                .put("app", "chat-outline")
                .put("version", 1)
                .put("prompts", JSONArray(merged.prompts.map { it.toJson() }))
                .put("tombstones", JSONArray(merged.tombstones.map { it.toJson() }))
                .toString(2)
                .toRequestBody(JSON)

            val guard: Pair<String, String>? = when {
                etag != null -> "If-Match" to etag
                remote != null -> null
                else -> "If-None-Match" to "*"
            }
            var res = put(base + FILE, auth, body, guard)
            if (res.code == 404 || res.code == 409) {
                res.close()
                val made = mkcol(base + FOLDER, auth)
                if (!made.isSuccessful && made.code != 405) {
                    made.close()
                    throw httpError(made.code)
                }
                made.close()
                res = put(base + FILE, auth, body, guard)
            }
            res.use {
                when {
                    it.code == 412 -> Unit // 下一轮重新读取
                    !it.isSuccessful -> throw httpError(it.code)
                    else -> return
                }
            }
        }
        throw SyncError("其他设备正在同步，请稍后再试")
    }

    private fun parseRemote(raw: String): SyncData? = runCatching {
        val o = JSONObject(raw)
        val arr = o.optJSONArray("prompts") ?: return null
        val prompts = List(arr.length()) { Prompt.fromJson(arr.getJSONObject(it)) }
        val ts = o.optJSONArray("tombstones") ?: JSONArray()
        val tombstones = List(ts.length()) { Tombstone.fromJson(ts.getJSONObject(it)) }
        SyncData(prompts, tombstones)
    }.getOrNull()

    private fun get(url: String, auth: String): Response =
        client.newCall(Request.Builder().url(url).header("Authorization", auth).get().build()).execute()

    private fun put(url: String, auth: String, body: RequestBody, guard: Pair<String, String>?): Response {
        val req = Request.Builder().url(url).header("Authorization", auth).put(body)
        if (guard != null) req.header(guard.first, guard.second)
        return client.newCall(req.build()).execute()
    }

    private fun mkcol(url: String, auth: String): Response {
        val req = Request.Builder().url(url).header("Authorization", auth)
            .method("MKCOL", null).build()
        return client.newCall(req).execute()
    }

    private fun httpError(code: Int): SyncError = SyncError(
        when (code) {
            401, 403 -> "账号或应用密码不对"
            429, 503 -> "网盘请求太频繁，请稍后再试"
            else -> "网盘返回错误 $code"
        },
    )

    private fun nowText(): String {
        val fmt = java.text.SimpleDateFormat("HH:mm", java.util.Locale.CHINA)
        return fmt.format(java.util.Date())
    }
}
