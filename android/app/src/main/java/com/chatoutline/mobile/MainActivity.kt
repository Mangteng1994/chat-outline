package com.chatoutline.mobile

import android.os.Bundle
import android.os.SystemClock
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Text
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.List
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.lifecycleScope
import com.chatoutline.mobile.data.Prompt
import com.chatoutline.mobile.data.PromptRepository
import com.chatoutline.mobile.overlay.OverlayService
import com.chatoutline.mobile.ui.ChatOutlineTheme
import com.chatoutline.mobile.ui.PermissionsScreen
import com.chatoutline.mobile.ui.PromptEditor
import com.chatoutline.mobile.ui.PromptsScreen
import com.chatoutline.mobile.ui.SyncScreen
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        PromptRepository.init(this)
        setContent {
            ChatOutlineTheme {
                AppRoot()
            }
        }
    }

    override fun onResume() {
        super.onResume()
        // 重装或被系统杀掉后服务不在，但开关仍是开：这里补启动，避免开关和实际不一致
        if (Settings.canDrawOverlays(this) && OverlayService.isBallVisible(this)) OverlayService.start(this)
        // 打开 App 时拉取一次，限制频率（最多约每分钟一次），和扩展一致
        val configured = PromptRepository.syncConfig() != null
        val due = SystemClock.elapsedRealtime() - lastAutoSyncAt > AUTO_SYNC_INTERVAL_MS
        if (configured && due) {
            lastAutoSyncAt = SystemClock.elapsedRealtime()
            lifecycleScope.launch { PromptRepository.sync() }
        }
    }

    companion object {
        private const val AUTO_SYNC_INTERVAL_MS = 60_000L
        private var lastAutoSyncAt = Long.MIN_VALUE / 2
    }
}

/** 编辑器的状态：null 表示没有打开编辑器；prompt 为 null 表示新建。 */
private class EditorTarget(val prompt: Prompt?)

private enum class Tab(val label: String) { PROMPTS("提示词"), SYNC("同步"), SETUP("设置") }

@Composable
private fun AppRoot() {
    var tabIndex by remember { mutableIntStateOf(0) }
    var editor by remember { mutableStateOf<EditorTarget?>(null) }
    val tab = Tab.entries[tabIndex]

    BackHandler(enabled = editor != null) { editor = null }

    val current = editor
    if (current != null) {
        PromptEditor(
            existing = current.prompt,
            onClose = { editor = null },
        )
        return
    }

    Scaffold(
        bottomBar = {
            Column {
                HorizontalDivider(thickness = 0.5.dp, color = MaterialTheme.colorScheme.outlineVariant)
                NavigationBar(
                    containerColor = MaterialTheme.colorScheme.background,
                    tonalElevation = 0.dp,
                ) {
                    Tab.entries.forEachIndexed { index, item ->
                        NavigationBarItem(
                            selected = tab == item,
                            onClick = { tabIndex = index },
                            icon = {
                                when (item) {
                                    Tab.PROMPTS -> Icon(Icons.AutoMirrored.Outlined.List, contentDescription = null)
                                    Tab.SYNC -> Icon(painterResource(R.drawable.ic_cloud), contentDescription = null)
                                    Tab.SETUP -> Icon(Icons.Outlined.Settings, contentDescription = null)
                                }
                            },
                            label = { Text(item.label) },
                            colors = NavigationBarItemDefaults.colors(
                                selectedIconColor = MaterialTheme.colorScheme.primary,
                                selectedTextColor = MaterialTheme.colorScheme.primary,
                                unselectedIconColor = MaterialTheme.colorScheme.outline,
                                unselectedTextColor = MaterialTheme.colorScheme.outline,
                                indicatorColor = Color.Transparent,
                            ),
                        )
                    }
                }
            }
        },
    ) { padding ->
        val modifier = Modifier.padding(padding)
        when (tab) {
            Tab.PROMPTS -> PromptsScreen(
                modifier = modifier,
                onEdit = { editor = EditorTarget(it) },
                onNew = { editor = EditorTarget(null) },
            )
            Tab.SYNC -> SyncScreen(modifier = modifier)
            Tab.SETUP -> PermissionsScreen(modifier = modifier)
        }
    }
}
