use gtk::prelude::*;

fn header_bar(widget: gtk::Widget) -> Option<gtk::HeaderBar> {
    if let Ok(header) = widget.clone().downcast::<gtk::HeaderBar>() {
        return Some(header);
    }
    widget
        .downcast::<gtk::Container>()
        .ok()?
        .children()
        .into_iter()
        .find_map(header_bar)
}

pub fn sync_header_title(window: &gtk::ApplicationWindow) {
    // Tao 0.35's Wayland decorations set a separate HeaderBar title once at
    // creation. Updating Window::title alone leaves that visible title stale.
    // X11 windows without a GTK title bar already follow the window title.
    if let Some(header) = window.titlebar().and_then(header_bar) {
        window
            .bind_property("title", &header, "title")
            .sync_create()
            .build();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "Requires a GTK display; run with --ignored --test-threads=1"]
    fn visible_header_follows_project_title_and_close() {
        gtk::init().expect("GTK display");
        let window = gtk::ApplicationWindow::builder()
            .title("Digital Genome Workstation")
            .build();
        let header = gtk::HeaderBar::builder().title("Old title").build();
        let wrapper = gtk::EventBox::new();
        wrapper.add(&header);
        window.set_titlebar(Some(&wrapper));
        sync_header_title(&window);

        assert_eq!(header.title().as_deref(), Some("Digital Genome Workstation"));
        window.set_title("DGW Allele Editing — GRCh37 — DGW");
        assert_eq!(header.title().as_deref(), Some("DGW Allele Editing — GRCh37 — DGW"));
        window.set_title("Digital Genome Workstation");
        assert_eq!(header.title().as_deref(), Some("Digital Genome Workstation"));
        window.close();
    }
}
