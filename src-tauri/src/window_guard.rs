//! Recover a persisted window that belongs to a monitor which no longer exists.
//!
//! Tauri's `preventOverflow` covers initial construction. This guard handles a
//! later monitor/DPI change too, and deliberately uses the OS work area rather
//! than full monitor bounds so a Dock or taskbar never hides top-chrome
//! controls.

use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize};

pub const WORK_AREA_MARGIN_PX: i32 = 16;
const MIN_WINDOW_WIDTH: u32 = 1024;
const MIN_WINDOW_HEIGHT: u32 = 640;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WindowRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WorkArea {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

pub fn rect_intersects_work_area(rect: WindowRect, work: WorkArea) -> bool {
    let rect_right = i64::from(rect.x) + i64::from(rect.width);
    let rect_bottom = i64::from(rect.y) + i64::from(rect.height);
    let work_right = i64::from(work.x) + i64::from(work.width);
    let work_bottom = i64::from(work.y) + i64::from(work.height);

    i64::from(rect.x) < work_right
        && rect_right > i64::from(work.x)
        && i64::from(rect.y) < work_bottom
        && rect_bottom > i64::from(work.y)
}

/// Fit an off-screen frame inside `work`, preserving the configured minimum
/// dimensions whenever the usable work area can accommodate them.
pub fn clamp_window_rect_to_work_area(rect: WindowRect, work: WorkArea) -> WindowRect {
    let horizontal_margin = WORK_AREA_MARGIN_PX.min((work.width / 2) as i32).max(0);
    let vertical_margin = WORK_AREA_MARGIN_PX.min((work.height / 2) as i32).max(0);
    let usable_width = work
        .width
        .saturating_sub((horizontal_margin as u32).saturating_mul(2));
    let usable_height = work
        .height
        .saturating_sub((vertical_margin as u32).saturating_mul(2));

    let width = if usable_width >= MIN_WINDOW_WIDTH {
        rect.width.clamp(MIN_WINDOW_WIDTH, usable_width)
    } else {
        rect.width.min(usable_width)
    };
    let height = if usable_height >= MIN_WINDOW_HEIGHT {
        rect.height.clamp(MIN_WINDOW_HEIGHT, usable_height)
    } else {
        rect.height.min(usable_height)
    };

    let min_x = work.x.saturating_add(horizontal_margin);
    let min_y = work.y.saturating_add(vertical_margin);
    let max_x = (i64::from(work.x) + i64::from(work.width)
        - i64::from(horizontal_margin)
        - i64::from(width))
    .clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32;
    let max_y = (i64::from(work.y) + i64::from(work.height)
        - i64::from(vertical_margin)
        - i64::from(height))
    .clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32;

    WindowRect {
        x: rect.x.clamp(min_x, max_x.max(min_x)),
        y: rect.y.clamp(min_y, max_y.max(min_y)),
        width,
        height,
    }
}

/// Re-home the main window only when it no longer intersects any usable area.
/// A normal partially-overlapping drag is left alone; this is recovery, not a
/// window manager.
pub fn clamp_main_window_to_work_area(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if window.is_minimized().unwrap_or(false) || window.is_maximized().unwrap_or(false) {
        return;
    }
    let (Ok(position), Ok(size)) = (window.outer_position(), window.outer_size()) else {
        return;
    };
    let current = WindowRect {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    };
    let monitors = window.available_monitors().unwrap_or_default();
    let active_work = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| {
            monitors
                .iter()
                .find(|monitor| {
                    let work = monitor.work_area();
                    rect_intersects_work_area(
                        current,
                        WorkArea {
                            x: work.position.x,
                            y: work.position.y,
                            width: work.size.width,
                            height: work.size.height,
                        },
                    )
                })
                .cloned()
        })
        .or_else(|| window.primary_monitor().ok().flatten())
        .or_else(|| monitors.first().cloned());
    let Some(monitor) = active_work else {
        return;
    };
    let work = monitor.work_area();
    let work = WorkArea {
        x: work.position.x,
        y: work.position.y,
        width: work.size.width,
        height: work.size.height,
    };
    if rect_intersects_work_area(current, work) {
        return;
    }

    let clamped = clamp_window_rect_to_work_area(current, work);
    if clamped.width != current.width || clamped.height != current.height {
        let _ = window.set_size(PhysicalSize::new(clamped.width, clamped.height));
    }
    let _ = window.set_position(PhysicalPosition::new(clamped.x, clamped.y));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_a_16_physical_pixel_margin_with_a_bottom_taskbar() {
        let work = WorkArea {
            x: 0,
            y: 0,
            width: 1920,
            height: 1040,
        };
        let clamped = clamp_window_rect_to_work_area(
            WindowRect {
                x: 3000,
                y: 2000,
                width: 1400,
                height: 900,
            },
            work,
        );
        assert_eq!(
            clamped,
            WindowRect {
                x: 504,
                y: 124,
                width: 1400,
                height: 900
            }
        );
    }

    #[test]
    fn supports_left_and_top_work_area_offsets() {
        let work = WorkArea {
            x: 96,
            y: 48,
            width: 1280,
            height: 720,
        };
        let clamped = clamp_window_rect_to_work_area(
            WindowRect {
                x: -2400,
                y: -1600,
                width: 1200,
                height: 800,
            },
            work,
        );
        assert_eq!(
            clamped,
            WindowRect {
                x: 112,
                y: 64,
                width: 1200,
                height: 688
            }
        );
    }

    #[test]
    fn shrinks_when_the_work_area_cannot_fit_the_configured_minimum() {
        let work = WorkArea {
            x: 0,
            y: 0,
            width: 1000,
            height: 620,
        };
        let clamped = clamp_window_rect_to_work_area(
            WindowRect {
                x: 2400,
                y: 1600,
                width: 1400,
                height: 900,
            },
            work,
        );
        assert_eq!(
            clamped,
            WindowRect {
                x: 16,
                y: 16,
                width: 968,
                height: 588
            }
        );
    }

    #[test]
    fn recognizes_frames_on_negative_coordinate_monitors() {
        let work = WorkArea {
            x: -1600,
            y: 0,
            width: 1600,
            height: 900,
        };
        assert!(rect_intersects_work_area(
            WindowRect {
                x: -1400,
                y: 100,
                width: 1024,
                height: 640
            },
            work,
        ));
        assert!(!rect_intersects_work_area(
            WindowRect {
                x: 20,
                y: 100,
                width: 1024,
                height: 640
            },
            work,
        ));
    }
}
