package com.chatoutline.mobile.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.chatoutline.mobile.data.PromptRepository
import kotlinx.coroutines.launch

// 已保存密码时，密码框里显示这一串点作为占位，可以逐个删除
private const val SAVED_MASK = "••••••••••••••••"

@Composable
fun SyncScreen(modifier: Modifier) {
    val status by PromptRepository.syncStatus.collectAsState()
    val syncing by PromptRepository.syncing.collectAsState()
    val scope = rememberCoroutineScope()

    val saved = remember { PromptRepository.savedSyncFields() }
    var url by remember { mutableStateOf(saved.url) }
    // 应用名称：坚果云里给应用密码起的名字，只用来核对是哪一个密码，不会上传
    var label by remember { mutableStateOf(saved.label) }
    var user by remember { mutableStateOf(saved.user) }
    // 已保存密码时，框里是一串点；只有输入了新文字才会替换密码，删掉点不影响已保存的密码
    var hasPassword by remember { mutableStateOf(saved.hasPassword) }
    var pass by remember { mutableStateOf(if (saved.hasPassword) SAVED_MASK else "") }
    val configured = PromptRepository.syncConfig() != null
    var message by remember { mutableStateOf<String?>(null) }

    Column(
        modifier = modifier
            .imePadding()
            .fillMaxWidth()
            .verticalScroll(rememberScrollState()),
    ) {
        ScreenHeader(title = "同步", subtitle = "和电脑扩展使用同一个坚果云文件")

        Group {
            Row(
                modifier = Modifier.padding(horizontal = Space.lg, vertical = 14.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                StatusDot(
                    when {
                        !configured -> statusColors.neutral
                        status.startsWith("已同步") -> statusColors.ok
                        else -> statusColors.pending
                    },
                )
                Spacer(Modifier.width(Space.md))
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = if (configured) status else "还没有设置同步",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    if (configured && saved.label.isNotBlank()) {
                        Text(
                            text = "应用密码：${saved.label}",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                if (syncing) {
                    CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
                }
            }
        }

        Column(
            modifier = Modifier.padding(horizontal = Space.page, vertical = Space.xl),
            verticalArrangement = Arrangement.spacedBy(Space.lg),
        ) {
            FormField(
                value = url,
                onValueChange = { url = it },
                label = "WebDAV 地址",
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next),
            )
            FormField(
                value = label,
                onValueChange = { label = it },
                label = "应用名称",
                hint = "坚果云里给这个应用密码起的名字，只存在本机",
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next),
            )
            FormField(
                value = user,
                onValueChange = { user = it },
                label = "账号",
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next),
            )
            FormField(
                value = pass,
                onValueChange = { v ->
                    val typed = v.replace("•", "")
                    // 删点时保留剩下的点；输入了文字才清掉点，替换为新密码
                    pass = if (typed.isEmpty()) v else typed
                },
                label = "应用密码",
                hint = if (hasPassword) "已加密保存在本机。输入新密码即替换，删掉全部点则保持不变"
                else "使用网盘的“应用密码”，不是登录密码",
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
            )

            message?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = statusColors.ok)
            }

            Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
                PrimaryButton(
                    text = "保存并同步",
                    onClick = {
                        PromptRepository.saveSyncConfig(url, label, user, pass.replace("•", ""))
                        hasPassword = true
                        pass = SAVED_MASK
                        message = null
                        scope.launch {
                            val ok = PromptRepository.sync()
                            message = if (ok) "已保存并同步" else null
                        }
                    },
                    enabled = !syncing && user.isNotBlank() && (hasPassword || pass.isNotBlank()),
                    modifier = Modifier.fillMaxWidth(),
                )
                if (configured) {
                    SoftButton(
                        text = "立即同步",
                        onClick = { scope.launch { PromptRepository.sync() } },
                        enabled = !syncing,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }

            Text(
                text = "首次同步前，建议先在电脑的扩展设置里导出一份备份，以防合并时误删。",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.outline,
            )

            if (configured) {
                TextButton(
                    onClick = {
                        PromptRepository.clearSyncConfig()
                        hasPassword = false
                        pass = ""
                        PromptRepository.setStatus("未同步")
                        message = "已清除同步设置，本地提示词保留"
                    },
                ) { Text("清除同步设置", color = MaterialTheme.colorScheme.error) }
            }
            Spacer(Modifier.height(Space.sm))
        }
    }
}
