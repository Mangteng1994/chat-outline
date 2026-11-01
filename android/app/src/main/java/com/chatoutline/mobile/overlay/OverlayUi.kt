package com.chatoutline.mobile.overlay

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.MutableTransitionState
import androidx.compose.animation.fadeIn
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.SnapshotStateMap
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.chatoutline.mobile.R
import com.chatoutline.mobile.data.Prompt
import com.chatoutline.mobile.data.PromptRepository
import com.chatoutline.mobile.fill.Variables
import com.chatoutline.mobile.ui.FormField
import com.chatoutline.mobile.ui.PrimaryButton
import com.chatoutline.mobile.ui.PromptItem
import com.chatoutline.mobile.ui.Radius
import com.chatoutline.mobile.ui.SearchField
import com.chatoutline.mobile.ui.SoftButton
import com.chatoutline.mobile.ui.Space
import com.chatoutline.mobile.ui.TagRow

private const val BALL_IDLE_ALPHA = 0.5f

/** 悬浮窗界面的状态。Service 和 Compose 共用。 */
class OverlayModel {
    var expanded by mutableStateOf(false)
    var editing by mutableStateOf<Prompt?>(null)
    var query by mutableStateOf("")
    var tag by mutableStateOf<String?>(null)
}

/** 界面向 Service 发出的动作。 */
interface OverlayActions {
    fun onBallTap()
    fun onBallDrag(dy: Float)
    fun onBallDragEnd()
    fun onCollapse()
    fun onSearchFocus()
    fun onChoose(prompt: Prompt)
    fun onCancelEdit()
    fun onFill(prompt: Prompt, values: Map<String, String>)
}

@Composable
fun OverlayRoot(model: OverlayModel, actions: OverlayActions) {
    if (model.expanded) Sheet(model = model, actions = actions) else Ball(actions = actions)
}

/** 收起态：不加阴影，窗口贴着球的尺寸，阴影会被裁成方块；用细描边在任何背景上保持轮廓。 */
@Composable
private fun Ball(actions: OverlayActions) {
    // 闲置时半透明，按住或拖动时恢复不透明
    var pressed by remember { mutableStateOf(false) }
    val ballAlpha by animateFloatAsState(if (pressed) 1f else BALL_IDLE_ALPHA, label = "ballAlpha")

    Box(
        modifier = Modifier
            .size(OverlayService.BALL_DP.dp)
            .alpha(ballAlpha)
            .pointerInput(Unit) {
                awaitEachGesture {
                    awaitFirstDown(requireUnconsumed = false)
                    pressed = true
                    do {
                        val event = awaitPointerEvent(PointerEventPass.Initial)
                    } while (event.changes.any { it.pressed })
                    pressed = false
                }
            }
            .clip(CircleShape)
            .background(MaterialTheme.colorScheme.primary)
            .border(1.dp, Color.White.copy(alpha = 0.55f), CircleShape)
            .pointerInput(Unit) {
                detectTapGestures(onTap = { actions.onBallTap() })
            }
            .pointerInput(Unit) {
                detectVerticalDragGestures(
                    onDragEnd = { actions.onBallDragEnd() },
                    onVerticalDrag = { change, dy ->
                        change.consume()
                        actions.onBallDrag(dy)
                    },
                )
            },
        contentAlignment = Alignment.CenterStart,
    ) {
        // 球的右侧藏在屏幕外，图标放在露出的部分
        Icon(
            painter = painterResource(R.drawable.ic_spark),
            contentDescription = "提示词",
            tint = MaterialTheme.colorScheme.onPrimary,
            modifier = Modifier
                .padding(start = 8.dp)
                .size(18.dp),
        )
    }
}

/** 展开态：窗口铺满屏幕，面板从底部升起，点空白处收起。 */
@Composable
private fun Sheet(model: OverlayModel, actions: OverlayActions) {
    val visible = remember { MutableTransitionState(false).apply { targetState = true } }
    val maxHeight = (LocalConfiguration.current.screenHeightDp * 0.62f).dp

    Box(modifier = Modifier.fillMaxSize()) {
        AnimatedVisibility(visibleState = visible, enter = fadeIn()) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(Color.Black.copy(alpha = 0.28f))
                    .pointerInput(Unit) {
                        detectTapGestures(onTap = { actions.onCollapse() })
                    },
            )
        }
        Box(
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .navigationBarsPadding()
                .imePadding()
                .padding(Space.sm),
        ) {
            AnimatedVisibility(
                visibleState = visible,
                enter = slideInVertically { it / 3 } + fadeIn(),
            ) {
                Surface(
                    modifier = Modifier
                        .widthIn(max = 480.dp)
                        .fillMaxWidth()
                        .heightIn(max = maxHeight),
                    shape = RoundedCornerShape(Radius.sheet),
                    color = MaterialTheme.colorScheme.surface,
                ) {
                    Column {
                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(top = Space.sm, bottom = Space.md),
                            contentAlignment = Alignment.Center,
                        ) {
                            Box(
                                modifier = Modifier
                                    .size(width = 32.dp, height = 4.dp)
                                    .clip(CircleShape)
                                    .background(MaterialTheme.colorScheme.outlineVariant),
                            )
                        }
                        val editing = model.editing
                        if (editing != null) {
                            VariableForm(prompt = editing, actions = actions)
                        } else {
                            PromptList(model = model, actions = actions)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun PromptList(model: OverlayModel, actions: OverlayActions) {
    val prompts by PromptRepository.prompts.collectAsState()
    val tags = remember(prompts) { prompts.flatMap { it.tags }.distinct().sorted() }
    val query = model.query.trim()
    val visible = prompts.filter { p ->
        (model.tag == null || model.tag in p.tags) &&
            (query.isEmpty() || p.title.contains(query, true) || p.content.contains(query, true))
    }

    Column {
        SearchField(
            value = model.query,
            onValueChange = { model.query = it },
            placeholder = "搜索提示词",
            modifier = Modifier.padding(horizontal = Space.lg),
            onFocused = actions::onSearchFocus,
        )
        if (tags.isNotEmpty()) {
            Spacer(Modifier.height(Space.md))
            TagRow(
                tags = tags,
                selected = model.tag,
                onSelect = { model.tag = it },
                sidePadding = Space.lg,
            )
        }
        Spacer(Modifier.height(Space.xs))

        if (visible.isEmpty()) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(120.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = if (prompts.isEmpty()) "还没有提示词，打开 App 添加" else "没有匹配的提示词",
                    color = MaterialTheme.colorScheme.outline,
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
        } else {
            LazyColumn(contentPadding = PaddingValues(bottom = Space.sm)) {
                items(visible, key = { it.id }) { p ->
                    PromptItem(prompt = p, sidePadding = Space.lg, onClick = { actions.onChoose(p) })
                }
            }
        }
    }
}

/** 有 {{变量}} 的提示词：先填变量，同名变量记住上次的值。 */
@Composable
private fun VariableForm(prompt: Prompt, actions: OverlayActions) {
    val names = remember(prompt.id) { Variables.namesIn(prompt.content) }
    val values: SnapshotStateMap<String, String> = remember(prompt.id) {
        val memory = PromptRepository.rememberedVariables()
        mutableStateMapOf<String, String>().apply {
            names.forEach { put(it, memory[it].orEmpty()) }
        }
    }

    Column(modifier = Modifier.padding(start = Space.xs, end = Space.lg, bottom = Space.lg)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = actions::onCancelEdit) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
            }
            Text(
                text = prompt.title.ifBlank { "填写变量" },
                style = MaterialTheme.typography.titleMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
        }

        Column(
            modifier = Modifier
                .padding(start = Space.md, top = Space.xs)
                .weight(1f, fill = false)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(Space.md),
        ) {
            names.forEachIndexed { index, name ->
                val isLast = index == names.lastIndex
                FormField(
                    value = values[name].orEmpty(),
                    onValueChange = { values[name] = it },
                    label = name,
                    singleLine = !prompt.content.contains("\n"),
                    keyboardOptions = KeyboardOptions(imeAction = if (isLast) ImeAction.Done else ImeAction.Next),
                    keyboardActions = KeyboardActions(onDone = { actions.onFill(prompt, values.toMap()) }),
                    onFocused = actions::onSearchFocus,
                )
            }
        }

        Spacer(Modifier.height(Space.lg))
        Row(modifier = Modifier.padding(start = Space.md)) {
            SoftButton(text = "取消", onClick = actions::onCancelEdit, modifier = Modifier.weight(1f))
            Spacer(Modifier.width(Space.sm))
            PrimaryButton(
                text = "填入",
                onClick = { actions.onFill(prompt, values.toMap()) },
                modifier = Modifier.weight(1f),
            )
        }
    }
}
