package com.chatoutline.mobile.fill

import android.accessibilityservice.AccessibilityService
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ComponentName
import android.os.Bundle
import android.provider.Settings
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo

/**
 * 把提示词填入当前输入框。
 *
 * 只在用户点提示词时工作：找到焦点输入框，优先粘贴（保留已有文字），
 * 粘贴不可用且输入框为空时直接写入；都失败时内容留在剪贴板，由用户手动粘贴。
 * 不读取、不保存、不上传其他屏幕内容；只记录最近获得焦点的输入框的引用，用于悬浮窗获得焦点后仍能找到它。
 */
class FillAccessibilityService : AccessibilityService() {

    enum class Result { FILLED, COPIED_ONLY }

    private var lastInput: AccessibilityNodeInfo? = null

    override fun onServiceConnected() {
        instance = this
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        if (event.eventType != AccessibilityEvent.TYPE_VIEW_FOCUSED) return
        val source = event.source ?: return
        // 忽略本应用自己的窗口（悬浮窗和主界面），只记录其他 App 的输入框
        if (source.packageName == packageName || !source.isEditable) {
            source.recycle()
            return
        }
        lastInput?.recycle()
        lastInput = source
    }

    override fun onInterrupt() = Unit

    override fun onUnbind(intent: android.content.Intent?): Boolean {
        instance = null
        return super.onUnbind(intent)
    }

    private fun targetInput(): AccessibilityNodeInfo? =
        rootInActiveWindow?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: lastInput

    fun fill(text: String): Result {
        val clipboard = getSystemService(CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("chat-outline", text))

        val node = targetInput() ?: return Result.COPIED_ONLY
        if (node.performAction(AccessibilityNodeInfo.ACTION_PASTE)) return Result.FILLED

        // 粘贴不可用时才直接写入，而且只在输入框为空时，避免覆盖用户已写的内容
        if (node.text.isNullOrEmpty()) {
            val args = Bundle().apply {
                putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
            }
            if (node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) return Result.FILLED
        }
        return Result.COPIED_ONLY
    }

    companion object {
        @Volatile
        var instance: FillAccessibilityService? = null
            private set

        fun isEnabled(context: android.content.Context): Boolean {
            val enabled = Settings.Secure.getString(
                context.contentResolver,
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
            ) ?: return false
            val name = ComponentName(context, FillAccessibilityService::class.java).flattenToString()
            return enabled.split(':').any { it.equals(name, ignoreCase = true) }
        }
    }
}
