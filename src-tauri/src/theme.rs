// GTK theme names that ship a dark variant (e.g. "Fluent-Dark-compact") don't
// necessarily flip `gtk-application-prefer-dark-theme` -- that property is
// normally set from the xdg-desktop-portal `Settings.Read` D-Bus call, which
// many window managers (XFCE included) don't run. WebKitGTK's
// `prefers-color-scheme` CSS feature reads this property, so without a
// fallback the app silently stays light even when the desktop is dark.
#[cfg(target_os = "linux")]
pub fn sync() {
    use gtk::prelude::*;

    let Some(settings) = gtk::Settings::default() else {
        return;
    };
    apply(&settings);
    settings.connect_gtk_theme_name_notify(apply);
}

#[cfg(target_os = "linux")]
fn apply(settings: &gtk::Settings) {
    use gtk::prelude::*;

    let looks_dark = settings
        .gtk_theme_name()
        .map(|name| name.to_lowercase().contains("dark"))
        .unwrap_or(false);
    if looks_dark && !settings.is_gtk_application_prefer_dark_theme() {
        settings.set_gtk_application_prefer_dark_theme(true);
    }
}

#[cfg(not(target_os = "linux"))]
pub fn sync() {}
