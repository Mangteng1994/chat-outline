package com.chatoutline.mobile.ui

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.unit.dp
import androidx.core.app.NotificationManagerCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import com.chatoutline.mobile.fill.FillAccessibilityService
import com.chatoutline.mobile.overlay.OverlayService

/** 权限和保活引导。小米/HyperOS 需要额外的省电和自启动设置，这里逐项列出。 */
@Composable
fun PermissionsScreen(modifier: Modifier) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current

    // 从系统设置返回时刷新状态
    var tick by remember { mutableIntStateOf(0) }
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) tick++
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    val overlayOn = remember(tick) { Settings.canDrawOverlays(context) }
    val accessibilityOn = remember(tick) { FillAccessibilityService.isEnabled(context) }
    val notifyOn = remember(tick) { NotificationManagerCompat.from(context).areNotificationsEnabled() }
    val batteryFree = remember(tick) {
        (context.getSystemService(PowerManager::class.java)).isIgnoringBatteryOptimizations(context.packageName)
    }
    var ballOn by remember(tick) { mutableStateOf(OverlayService.isBallVisible(context) && overlayOn) }

    val notifyLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        tick++
    }

    val needsNotify = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
    val remaining = listOf(overlayOn, accessibilityOn, !needsNotify || notifyOn, batteryFree).count { !it }

    Column(
        modifier = modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState()),
    ) {
        ScreenHeader(
            title = "设置",
            subtitle = if (remaining == 0) "全部就绪" else "还差 $remaining 项",
        )

        Group {
            Row(
                modifier = Modifier.padding(horizontal = Space.lg, vertical = Space.md),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text("显示悬浮球", style = MaterialTheme.typography.bodyLarge)
                    if (!overlayOn) {
                        Text(
                            text = "需要先开启悬浮窗权限",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                Switch(
                    checked = ballOn,
                    enabled = overlayOn,
                    onCheckedChange = { on ->
                        ballOn = on
                        if (on) OverlayService.start(context) else OverlayService.stop(context)
                    },
                    colors = SwitchDefaults.colors(uncheckedTrackColor = MaterialTheme.colorScheme.outlineVariant),
                )
            }
        }

        Spacer(Modifier.height(Space.md))

        Group {
            SetupRow(
                title = "悬浮窗",
                desc = "让悬浮球显示在其他 App 上面",
                done = overlayOn,
                actionLabel = "去开启",
                onClick = {
                    context.startActivity(
                        Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:${context.packageName}")),
                    )
                },
            )
            GroupDivider()
            SetupRow(
                title = "无障碍",
                desc = "把提示词填入当前输入框",
                done = accessibilityOn,
                actionLabel = "去开启",
                onClick = { context.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) },
            )
            if (needsNotify) {
                GroupDivider()
                SetupRow(
                    title = "通知",
                    desc = "用于保活，也可在通知里隐藏悬浮球",
                    done = notifyOn,
                    actionLabel = "去开启",
                    onClick = { notifyLauncher.launch(Manifest.permission.POST_NOTIFICATIONS) },
                )
            }
            GroupDivider()
            SetupRow(
                title = "省电无限制",
                desc = "在电池管理里选“无限制”，否则悬浮球容易被杀掉",
                done = batteryFree,
                actionLabel = "去设置",
                onClick = { context.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) },
            )
            GroupDivider()
            SetupRow(
                title = "自启动",
                desc = "小米 / HyperOS 在应用管理里开启，重启后悬浮球才会恢复",
                done = null,
                actionLabel = "手动检查",
                onClick = {
                    context.startActivity(
                        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}")),
                    )
                },
            )
        }

        Text(
            text = "无障碍服务只在你点提示词时填入内容，不读取、不保存、不上传其他屏幕内容。",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.outline,
            modifier = Modifier.padding(horizontal = Space.page, vertical = Space.md),
        )
        Spacer(Modifier.height(Space.md))
    }
}

/** done 为 null 表示无法检测，只提供入口。已完成的项收起说明，让未完成的更显眼。 */
@Composable
private fun SetupRow(
    title: String,
    desc: String,
    done: Boolean?,
    actionLabel: String,
    onClick: () -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = Space.lg, vertical = Space.md),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        StatusDot(
            when (done) {
                true -> statusColors.ok
                false -> statusColors.pending
                null -> statusColors.neutral
            },
        )
        Spacer(Modifier.width(Space.md))
        Column(modifier = Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge)
            if (done != true) {
                Text(desc, style = MaterialTheme.typography.bodySmall, color = colors.onSurfaceVariant)
            }
        }
        Spacer(Modifier.width(Space.sm))
        if (done == true) {
            Text("已开启", style = MaterialTheme.typography.bodySmall, color = colors.outline)
        } else {
            Text(
                text = actionLabel,
                style = MaterialTheme.typography.labelMedium,
                color = if (done == false) colors.primary else colors.onSurfaceVariant,
            )
            Icon(
                imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
                contentDescription = null,
                tint = colors.outline,
                modifier = Modifier.size(18.dp),
            )
        }
    }
}
