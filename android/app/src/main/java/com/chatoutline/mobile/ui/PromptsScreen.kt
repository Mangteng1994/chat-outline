package com.chatoutline.mobile.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.chatoutline.mobile.data.Prompt
import com.chatoutline.mobile.data.PromptRepository
import com.chatoutline.mobile.data.newPromptId

@Composable
fun PromptsScreen(modifier: Modifier, onEdit: (Prompt) -> Unit, onNew: () -> Unit) {
    val prompts by PromptRepository.prompts.collectAsState()
    var query by remember { mutableStateOf("") }
    var tag by remember { mutableStateOf<String?>(null) }
    val tags = remember(prompts) { prompts.flatMap { it.tags }.distinct().sorted() }
    val q = query.trim()
    val visible = prompts.filter { p ->
        (tag == null || tag in p.tags) &&
            (q.isEmpty() || p.title.contains(q, true) || p.content.contains(q, true))
    }

    Column(modifier = modifier.fillMaxSize()) {
        ScreenHeader(
            title = "提示词",
            subtitle = "${prompts.size} 条",
            trailing = {
                Box(
                    modifier = Modifier
                        .size(38.dp)
                        .clip(CircleShape)
                        .background(MaterialTheme.colorScheme.primaryContainer)
                        .clickable(onClick = onNew),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        imageVector = Icons.Filled.Add,
                        contentDescription = "新建",
                        tint = MaterialTheme.colorScheme.onPrimaryContainer,
                    )
                }
            },
        )

        SearchField(
            value = query,
            onValueChange = { query = it },
            placeholder = "搜索标题或内容",
            modifier = Modifier.padding(horizontal = Space.page),
        )
        if (tags.isNotEmpty()) {
            Spacer(Modifier.height(Space.md))
            TagRow(tags = tags, selected = tag, onSelect = { tag = it }, sidePadding = Space.page)
        }
        Spacer(Modifier.height(Space.xs))

        if (visible.isEmpty()) {
            Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text(
                    text = if (prompts.isEmpty()) "写下第一条提示词\n点右上角的加号" else "没有匹配的提示词",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.outline,
                    textAlign = TextAlign.Center,
                )
            }
        } else {
            LazyColumn(contentPadding = PaddingValues(bottom = Space.xl)) {
                items(visible, key = { it.id }) { p ->
                    PromptItem(prompt = p, sidePadding = Space.page, onClick = { onEdit(p) })
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PromptEditor(existing: Prompt?, onClose: () -> Unit) {
    var title by remember { mutableStateOf(existing?.title.orEmpty()) }
    var tagsText by remember { mutableStateOf(existing?.tags?.joinToString("，").orEmpty()) }
    var content by remember { mutableStateOf(existing?.content.orEmpty()) }
    var confirmDelete by remember { mutableStateOf(false) }
    val canSave = title.isNotBlank() || content.isNotBlank()

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        text = if (existing == null) "新建提示词" else "编辑提示词",
                        style = MaterialTheme.typography.titleMedium,
                    )
                },
                navigationIcon = {
                    IconButton(onClick = onClose) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                    }
                },
                actions = {
                    if (existing != null) {
                        IconButton(onClick = { confirmDelete = true }) {
                            Icon(
                                imageVector = Icons.Outlined.Delete,
                                contentDescription = "删除",
                                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                    TextButton(
                        onClick = {
                            PromptRepository.save(
                                Prompt(
                                    id = existing?.id ?: newPromptId(),
                                    title = title.trim(),
                                    content = content.trimEnd(),
                                    tags = parseTags(tagsText),
                                    updatedAt = 0L,
                                ),
                            )
                            onClose()
                        },
                        enabled = canSave,
                    ) { Text("保存", style = MaterialTheme.typography.labelLarge) }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .padding(padding)
                .imePadding()
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = Space.page, vertical = Space.sm),
            verticalArrangement = Arrangement.spacedBy(Space.lg),
        ) {
            FormField(
                value = title,
                onValueChange = { title = it },
                label = "标题",
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next),
            )
            FormField(
                value = tagsText,
                onValueChange = { tagsText = it },
                label = "标签",
                hint = "用逗号分隔，可留空",
            )
            FormField(
                value = content,
                onValueChange = { content = it },
                label = "内容",
                hint = "写 {{变量名}} 可在填入时临时替换",
                singleLine = false,
                minLines = 10,
            )
            Spacer(Modifier.height(Space.xl))
        }
    }

    if (confirmDelete && existing != null) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            containerColor = MaterialTheme.colorScheme.surface,
            title = { Text("删除这条提示词？", style = MaterialTheme.typography.titleMedium) },
            text = { Text("删除后，其他设备同步时也会删除。", style = MaterialTheme.typography.bodyMedium) },
            confirmButton = {
                TextButton(onClick = {
                    PromptRepository.delete(existing.id)
                    onClose()
                }) { Text("删除", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = {
                TextButton(onClick = { confirmDelete = false }) { Text("取消") }
            },
        )
    }
}

private fun parseTags(raw: String): List<String> =
    raw.split(',', '，', '、')
        .map { it.trim() }
        .filter { it.isNotEmpty() }
        .distinct()
