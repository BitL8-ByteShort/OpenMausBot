package com.openmausbot.companion.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandHorizontally
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkHorizontally
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.materialIcon
import androidx.compose.material.icons.materialPath
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp

/** One control in a bubble's tray — the port of `MessageAction` in `ios/App/ChatView.swift`. */
data class TrayAction(
    val label: String,
    val icon: ImageVector,
    val enabled: Boolean = true,
    val onClick: () -> Unit,
)

/**
 * One "…" handle beside a bubble. Tapping it slides the controls out sideways,
 * away from the bubble — the phone's version of the desktop tray, where hover
 * does the opening. [mirrored] puts the handle nearest the bubble on your own
 * side, so the first control stays next to it on both. Long-press still opens
 * the full menu; this is the discoverable route.
 */
@Composable
fun MessageActionTray(
    mirrored: Boolean,
    actions: List<TrayAction>,
    modifier: Modifier = Modifier,
) {
    var open by remember { mutableStateOf(false) }
    val tint = secondaryTint

    @Composable
    fun controls() {
        AnimatedVisibility(
            visible = open,
            enter = expandHorizontally(expandFrom = if (mirrored) Alignment.End else Alignment.Start) + fadeIn(),
            exit = shrinkHorizontally(shrinkTowards = if (mirrored) Alignment.End else Alignment.Start) + fadeOut(),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                actions.forEach { action ->
                    IconButton(
                        onClick = action.onClick,
                        enabled = action.enabled,
                        modifier = Modifier.size(32.dp),
                    ) {
                        Icon(
                            imageVector = action.icon,
                            contentDescription = action.label,
                            tint = if (action.enabled) tint else tint.copy(alpha = 0.4f),
                            modifier = Modifier.size(16.dp),
                        )
                    }
                }
            }
        }
    }

    @Composable
    fun handle() {
        IconButton(
            onClick = { open = !open },
            modifier = Modifier
                .size(32.dp)
                .background(if (open) tint.copy(alpha = 0.18f) else Color.Transparent, CircleShape),
        ) {
            Icon(
                imageVector = TrayIcons.MoreHoriz,
                contentDescription = "Message actions",
                tint = if (open) tint else tint.copy(alpha = 0.5f),
                modifier = Modifier.size(16.dp),
            )
        }
    }

    Row(
        modifier = modifier.padding(horizontal = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (mirrored) {
            controls()
            handle()
        } else {
            handle()
            controls()
        }
    }
}

/**
 * Material glyphs the tray needs that `material-icons-core` does not ship.
 * Path data is the stock Material Symbols outline, on the 24dp grid.
 */
object TrayIcons {
    val MoreHoriz: ImageVector by lazy {
        materialIcon(name = "Filled.MoreHoriz") {
            materialPath {
                moveTo(6f, 10f); curveToRelative(-1.1f, 0f, -2f, 0.9f, -2f, 2f)
                reflectiveCurveToRelative(0.9f, 2f, 2f, 2f); reflectiveCurveToRelative(2f, -0.9f, 2f, -2f)
                reflectiveCurveToRelative(-0.9f, -2f, -2f, -2f); close()
                moveTo(18f, 10f); curveToRelative(-1.1f, 0f, -2f, 0.9f, -2f, 2f)
                reflectiveCurveToRelative(0.9f, 2f, 2f, 2f); reflectiveCurveToRelative(2f, -0.9f, 2f, -2f)
                reflectiveCurveToRelative(-0.9f, -2f, -2f, -2f); close()
                moveTo(12f, 10f); curveToRelative(-1.1f, 0f, -2f, 0.9f, -2f, 2f)
                reflectiveCurveToRelative(0.9f, 2f, 2f, 2f); reflectiveCurveToRelative(2f, -0.9f, 2f, -2f)
                reflectiveCurveToRelative(-0.9f, -2f, -2f, -2f); close()
            }
        }
    }

    val ContentCopy: ImageVector by lazy {
        materialIcon(name = "Outlined.ContentCopy") {
            materialPath {
                moveTo(16f, 1f); horizontalLineTo(4f); curveToRelative(-1.1f, 0f, -2f, 0.9f, -2f, 2f)
                verticalLineToRelative(14f); horizontalLineToRelative(2f); verticalLineTo(3f)
                horizontalLineToRelative(12f); verticalLineTo(1f); close()
                moveTo(19f, 5f); horizontalLineTo(8f); curveToRelative(-1.1f, 0f, -2f, 0.9f, -2f, 2f)
                verticalLineToRelative(14f); curveToRelative(0f, 1.1f, 0.9f, 2f, 2f, 2f)
                horizontalLineToRelative(11f); curveToRelative(1.1f, 0f, 2f, -0.9f, 2f, -2f)
                verticalLineTo(7f); curveToRelative(0f, -1.1f, -0.9f, -2f, -2f, -2f); close()
                moveTo(19f, 21f); horizontalLineTo(8f); verticalLineTo(7f); horizontalLineToRelative(11f)
                verticalLineToRelative(14f); close()
            }
        }
    }

    val SelectAll: ImageVector by lazy {
        materialIcon(name = "Outlined.SelectAll") {
            materialPath {
                moveTo(3f, 5f); horizontalLineToRelative(2f); verticalLineTo(3f)
                curveToRelative(-1.1f, 0f, -2f, 0.9f, -2f, 2f); close()
                moveTo(3f, 13f); horizontalLineToRelative(2f); verticalLineToRelative(-2f); horizontalLineTo(3f); close()
                moveTo(7f, 21f); horizontalLineToRelative(2f); verticalLineToRelative(-2f); horizontalLineTo(7f); close()
                moveTo(3f, 9f); horizontalLineToRelative(2f); verticalLineTo(7f); horizontalLineTo(3f); close()
                moveTo(13f, 3f); horizontalLineToRelative(-2f); verticalLineToRelative(2f); horizontalLineToRelative(2f); close()
                moveTo(19f, 3f); verticalLineToRelative(2f); horizontalLineToRelative(2f)
                curveToRelative(0f, -1.1f, -0.9f, -2f, -2f, -2f); close()
                moveTo(5f, 21f); verticalLineToRelative(-2f); horizontalLineTo(3f)
                curveToRelative(0f, 1.1f, 0.9f, 2f, 2f, 2f); close()
                moveTo(3f, 17f); horizontalLineToRelative(2f); verticalLineToRelative(-2f); horizontalLineTo(3f); close()
                moveTo(9f, 3f); horizontalLineTo(7f); verticalLineToRelative(2f); horizontalLineToRelative(2f); close()
                moveTo(11f, 21f); horizontalLineToRelative(2f); verticalLineToRelative(-2f); horizontalLineToRelative(-2f); close()
                moveTo(19f, 13f); horizontalLineToRelative(2f); verticalLineToRelative(-2f); horizontalLineToRelative(-2f); close()
                moveTo(19f, 21f); curveToRelative(1.1f, 0f, 2f, -0.9f, 2f, -2f); horizontalLineToRelative(-2f); close()
                moveTo(19f, 9f); horizontalLineToRelative(2f); verticalLineTo(7f); horizontalLineToRelative(-2f); close()
                moveTo(19f, 17f); horizontalLineToRelative(2f); verticalLineToRelative(-2f); horizontalLineToRelative(-2f); close()
                moveTo(15f, 21f); horizontalLineToRelative(2f); verticalLineToRelative(-2f); horizontalLineToRelative(-2f); close()
                moveTo(15f, 5f); horizontalLineToRelative(2f); verticalLineTo(3f); horizontalLineToRelative(-2f); close()
                moveTo(7f, 17f); horizontalLineToRelative(10f); verticalLineTo(7f); horizontalLineTo(7f); close()
                moveTo(9f, 9f); horizontalLineToRelative(6f); verticalLineToRelative(6f); horizontalLineTo(9f); close()
            }
        }
    }

    val Edit: ImageVector get() = Icons.Filled.Edit
}
