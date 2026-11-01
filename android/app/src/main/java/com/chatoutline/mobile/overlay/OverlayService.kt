package com.chatoutline.mobile.overlay

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.PixelFormat
import android.os.Build
import android.provider.Settings
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.view.inputmethod.InputMethodManager
import android.widget.FrameLayout
import android.widget.Toast
import androidx.compose.ui.platform.ComposeView
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleService
import androidx.lifecycle.setViewTreeLifecycleOwner
import androidx.lifecycle.setViewTreeViewModelStoreOwner
import androidx.savedstate.setViewTreeSavedStateRegistryOwner
import com.chatoutline.mobile.MainActivity
import com.chatoutline.mobile.R
import com.chatoutline.mobile.data.Prompt
import com.chatoutline.mobile.data.PromptRepository
import com.chatoutline.mobile.fill.FillAccessibilityService
import com.chatoutline.mobile.fill.Variables
import com.chatoutline.mobile.ui.ChatOutlineTheme
import kotlin.math.roundToInt

/**
 * 全局悬浮球。贴在屏幕右边缘、部分隐藏，点开后窗口铺满屏幕，面板从底部升起。
 * 面板默认不可获得焦点，只有点搜索框或变量框时才接收键盘输入。
 */
class OverlayService : LifecycleService(), OverlayActions {

    companion object {
        const val ACTION_TOGGLE_BALL = "com.chatoutline.mobile.TOGGLE_BALL"
        const val ACTION_STOP = "com.chatoutline.mobile.STOP"

        private const val CHANNEL_ID = "overlay"
        private const val NOTIFICATION_ID = 1
        private const val PREFS = "chat_outline"
        private const val PREF_BALL_VISIBLE = "ball_visible"
        private const val PREF_BALL_Y = "ball_y"
        const val BALL_DP = 44
        private const val BALL_HIDDEN_DP = 14
        private const val BALL_Y_DEFAULT_DP = 140

        /** 开启悬浮球：同时把“显示”状态写回，避免之前被通知栏隐藏后打不开。 */
        fun start(context: Context) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(PREF_BALL_VISIBLE, true).apply()
            ContextCompat.startForegroundService(context, Intent(context, OverlayService::class.java))
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, OverlayService::class.java))
        }

        fun isBallVisible(context: Context): Boolean =
            context.getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean(PREF_BALL_VISIBLE, true)
    }

    private lateinit var wm: WindowManager
    private lateinit var params: WindowManager.LayoutParams
    private lateinit var prefs: android.content.SharedPreferences
    private var overlayView: View? = null
    private var owner: OverlayOwner? = null
    private val model = OverlayModel()
    private var focusable = false

    override fun onCreate() {
        super.onCreate()
        PromptRepository.init(this)
        wm = getSystemService(WINDOW_SERVICE) as WindowManager
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        if (!Settings.canDrawOverlays(this)) {
            stopSelf()
            return START_NOT_STICKY
        }
        if (intent?.action == ACTION_TOGGLE_BALL) {
            prefs.edit().putBoolean(PREF_BALL_VISIBLE, !isBallVisible(this)).apply()
        }
        startForegroundNotification()
        overlayView?.visibility = if (isBallVisible(this)) View.VISIBLE else View.GONE
        if (overlayView == null) addOverlay()
        return START_STICKY
    }

    override fun onDestroy() {
        overlayView?.let { runCatching { wm.removeView(it) } }
        overlayView = null
        owner?.destroy()
        owner = null
        super.onDestroy()
    }

    // 窗口

    private fun addOverlay() {
        val lifecycleOwner = OverlayOwner().also { owner = it }
        val compose = ComposeView(this).apply {
            setContent {
                ChatOutlineTheme {
                    OverlayRoot(model = model, actions = this@OverlayService)
                }
            }
        }
        // Compose 从窗口根视图取这些 owner，要设在最外层
        val view = OverlayFrame().apply {
            setViewTreeLifecycleOwner(lifecycleOwner)
            setViewTreeSavedStateRegistryOwner(lifecycleOwner)
            setViewTreeViewModelStoreOwner(lifecycleOwner)
            addView(compose)
        }
        params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
                WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.END
            y = ballY()
            x = collapsedX()
            softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE
            // 遮罩铺到系统栏下面，避让由面板自己处理
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                fitInsetsTypes = 0
                layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
            }
        }
        wm.addView(view, params)
        lifecycleOwner.resume()
        overlayView = view
        overlayView?.visibility = if (isBallVisible(this)) View.VISIBLE else View.GONE
    }

    /** 窗口有焦点时接住返回键：变量表单退回列表，列表收起面板。 */
    private inner class OverlayFrame : FrameLayout(this@OverlayService) {
        override fun dispatchKeyEvent(event: KeyEvent): Boolean {
            if (event.keyCode != KeyEvent.KEYCODE_BACK || !model.expanded) return super.dispatchKeyEvent(event)
            if (event.action == KeyEvent.ACTION_UP) {
                if (model.editing != null) onCancelEdit() else collapse()
            }
            return true
        }
    }

    /** 收起时把球的一部分移出屏幕右边缘。 */
    private fun collapsedX(): Int = -(BALL_HIDDEN_DP * resources.displayMetrics.density).roundToInt()

    private fun ballY(): Int =
        prefs.getInt(PREF_BALL_Y, (BALL_Y_DEFAULT_DP * resources.displayMetrics.density).roundToInt())

    private fun updateWindow() {
        overlayView?.let { wm.updateViewLayout(it, params) }
    }

    private fun setFocusable(on: Boolean) {
        if (focusable == on) return
        focusable = on
        params.flags = if (on) {
            params.flags and WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE.inv()
        } else {
            params.flags or WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
        }
        updateWindow()
        // 窗口刚变成可获得焦点时，系统不会自动弹键盘，这里补一次
        if (on) {
            overlayView?.postDelayed({
                val target = overlayView?.findFocus() ?: return@postDelayed
                getSystemService(InputMethodManager::class.java).showSoftInput(target, 0)
            }, 120)
        }
    }

    // 悬浮球和面板的动作

    override fun onBallTap() {
        if (model.expanded) {
            collapse()
            return
        }
        params.width = WindowManager.LayoutParams.MATCH_PARENT
        params.height = WindowManager.LayoutParams.MATCH_PARENT
        params.x = 0
        params.y = 0
        params.flags = params.flags and WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS.inv()
        updateWindow()
        model.expanded = true
    }

    override fun onBallDrag(dy: Float) {
        params.y = (params.y + dy.roundToInt()).coerceAtLeast(0)
        updateWindow()
    }

    override fun onBallDragEnd() {
        prefs.edit().putInt(PREF_BALL_Y, params.y).apply()
    }

    override fun onCollapse() = collapse()

    override fun onSearchFocus() = setFocusable(true)

    override fun onChoose(prompt: Prompt) {
        if (Variables.namesIn(prompt.content).isEmpty()) {
            deliver(prompt, emptyMap())
            return
        }
        model.editing = prompt
        setFocusable(true)
    }

    override fun onCancelEdit() {
        model.editing = null
        setFocusable(false)
    }

    override fun onFill(prompt: Prompt, values: Map<String, String>) = deliver(prompt, values)

    private fun collapse() {
        model.expanded = false
        model.editing = null
        focusable = false
        params.width = WindowManager.LayoutParams.WRAP_CONTENT
        params.height = WindowManager.LayoutParams.WRAP_CONTENT
        params.x = collapsedX()
        params.y = ballY()
        params.flags = params.flags or
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
            WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
        updateWindow()
    }

    /**
     * 收起面板并把内容交给无障碍服务填入。
     * 先收起并释放焦点，让目标 App 重新获得输入框焦点，再延迟执行填入。
     */
    private fun deliver(prompt: Prompt, values: Map<String, String>) {
        val text = Variables.render(prompt.content, values)
        if (values.isNotEmpty()) PromptRepository.rememberVariables(values)
        collapse()
        overlayView?.postDelayed({
            val service = FillAccessibilityService.instance
            if (service == null) {
                copyToClipboard(text)
                toast("请先开启无障碍服务，已复制到剪贴板")
                return@postDelayed
            }
            when (service.fill(text)) {
                FillAccessibilityService.Result.FILLED -> Unit
                FillAccessibilityService.Result.COPIED_ONLY -> {
                    copyToClipboard(text)
                    toast("没找到可输入的地方，已复制，请长按输入框粘贴")
                }
            }
        }, 180)
    }

    private fun copyToClipboard(text: String) {
        val clipboard = getSystemService(CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("chat-outline", text))
    }

    private fun toast(message: String) = Toast.makeText(this, message, Toast.LENGTH_SHORT).show()

    // 常驻通知：保活，并提供隐藏或显示悬浮球的开关

    private fun createChannel() {
        val channel = NotificationChannel(CHANNEL_ID, "悬浮球", NotificationManager.IMPORTANCE_LOW)
        channel.setShowBadge(false)
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    private fun startForegroundNotification() {
        ServiceCompat.startForeground(
            this,
            NOTIFICATION_ID,
            buildNotification(),
            android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
        )
    }

    private fun buildNotification(): Notification {
        val openApp = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val toggle = PendingIntent.getService(
            this, 1,
            Intent(this, OverlayService::class.java).setAction(ACTION_TOGGLE_BALL),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val toggleLabel = if (isBallVisible(this)) "隐藏悬浮球" else "显示悬浮球"
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_spark)
            .setContentTitle("chat-outline 悬浮球已开启")
            .setContentText("点悬浮球，选择提示词填入当前输入框")
            .setContentIntent(openApp)
            .addAction(0, toggleLabel, toggle)
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }
}
