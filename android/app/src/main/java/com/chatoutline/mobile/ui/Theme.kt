package com.chatoutline.mobile.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// 颜色取自扩展 content.js 的 :host 变量，两端保持一致；不跟随系统动态取色
private val PageLight = Color(0xFFFFFFFF)
private val FillLight = Color(0xFFF6F6F4)
private val TextLight = Color(0xFF1F1F1E)
private val PageDark = Color(0xFF262624)
private val FillDark = Color(0xFF30302E)
private val TextDark = Color(0xFFECECEA)

private val LightColors = lightColorScheme(
    primary = Color(0xFF185FA5),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFE6F0FB),
    onPrimaryContainer = Color(0xFF185FA5),
    secondary = Color(0xFF5F5E5A),
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFE6F0FB),
    onSecondaryContainer = Color(0xFF185FA5),
    tertiary = Color(0xFF5F5E5A),
    onTertiary = Color.White,
    background = PageLight,
    onBackground = TextLight,
    surface = PageLight,
    onSurface = TextLight,
    surfaceVariant = FillLight,
    onSurfaceVariant = Color(0xFF5F5E5A),
    surfaceTint = Color(0xFF185FA5),
    surfaceBright = PageLight,
    surfaceDim = FillLight,
    surfaceContainerLowest = PageLight,
    surfaceContainerLow = PageLight,
    surfaceContainer = PageLight,
    surfaceContainerHigh = PageLight,
    surfaceContainerHighest = FillLight,
    outline = Color(0xFF9A9893),
    outlineVariant = Color(0xFFEBEBE8),
    error = Color(0xFFB42318),
)

private val DarkColors = darkColorScheme(
    primary = Color(0xFFA9CDF2),
    onPrimary = Color(0xFF12304F),
    primaryContainer = Color(0xFF1D3A5C),
    onPrimaryContainer = Color(0xFFA9CDF2),
    secondary = Color(0xFFB4B2A9),
    onSecondary = Color(0xFF262624),
    secondaryContainer = Color(0xFF1D3A5C),
    onSecondaryContainer = Color(0xFFA9CDF2),
    tertiary = Color(0xFFB4B2A9),
    onTertiary = Color(0xFF262624),
    background = PageDark,
    onBackground = TextDark,
    surface = PageDark,
    onSurface = TextDark,
    surfaceVariant = FillDark,
    onSurfaceVariant = Color(0xFFB4B2A9),
    surfaceTint = Color(0xFFA9CDF2),
    surfaceBright = FillDark,
    surfaceDim = PageDark,
    surfaceContainerLowest = PageDark,
    surfaceContainerLow = PageDark,
    surfaceContainer = PageDark,
    surfaceContainerHigh = PageDark,
    surfaceContainerHighest = FillDark,
    outline = Color(0xFF85837C),
    outlineVariant = Color(0xFF3A3A37),
    error = Color(0xFFF19A90),
)

/** 间距 token：页面和组件只引用这里，不写字面量。 */
object Space {
    val xs = 4.dp
    val sm = 8.dp
    val md = 12.dp
    val lg = 16.dp
    val xl = 24.dp
    val page = 20.dp
}

/** 圆角 token。 */
object Radius {
    val sm = 10.dp
    val md = 12.dp
    val lg = 16.dp
    val sheet = 24.dp
}

/** 状态色：主色只用于操作，状态单独用这组颜色。 */
class StatusColors(val ok: Color, val pending: Color, val neutral: Color)

private val LightStatus = StatusColors(Color(0xFF2B6F3E), Color(0xFFD99A0B), Color(0xFF9A9893))
private val DarkStatus = StatusColors(Color(0xFF9FD9B0), Color(0xFFF2B632), Color(0xFF85837C))

val statusColors: StatusColors
    @Composable get() = if (isSystemInDarkTheme()) DarkStatus else LightStatus

private val AppShapes = Shapes(
    small = RoundedCornerShape(Radius.sm),
    medium = RoundedCornerShape(Radius.md),
    large = RoundedCornerShape(Radius.lg),
)

// 中文用 Medium 就足够有层次，SemiBold 以上在小屏上发闷
private val AppTypography = Typography(
    headlineMedium = TextStyle(fontSize = 26.sp, lineHeight = 34.sp, fontWeight = FontWeight.Medium),
    titleMedium = TextStyle(fontSize = 16.sp, lineHeight = 24.sp, fontWeight = FontWeight.Medium),
    titleSmall = TextStyle(fontSize = 15.sp, lineHeight = 22.sp, fontWeight = FontWeight.Medium),
    bodyLarge = TextStyle(fontSize = 15.sp, lineHeight = 22.sp),
    bodyMedium = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
    bodySmall = TextStyle(fontSize = 12.sp, lineHeight = 18.sp),
    labelLarge = TextStyle(fontSize = 14.sp, lineHeight = 20.sp, fontWeight = FontWeight.Medium),
    labelMedium = TextStyle(fontSize = 12.sp, lineHeight = 16.sp, fontWeight = FontWeight.Medium),
    labelSmall = TextStyle(fontSize = 11.sp, lineHeight = 14.sp),
)

@Composable
fun ChatOutlineTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (isSystemInDarkTheme()) DarkColors else LightColors,
        shapes = AppShapes,
        typography = AppTypography,
        content = content,
    )
}
