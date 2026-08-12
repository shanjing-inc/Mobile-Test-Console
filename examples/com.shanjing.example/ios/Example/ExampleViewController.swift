import UIKit
import Lynx

final class ExampleViewController: UIViewController {
    private let lifecycleClient = ExampleLynxLifecycleClient()
    private var lynxView: LynxView?
    private var hasLoadedTemplate = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .white

        let lynxView = LynxView { builder in
            builder.screenSize = UIScreen.main.bounds.size
            builder.fontScale = 1.0
            builder.debuggable = false
        }
        lynxView.layoutWidthMode = .exact
        lynxView.layoutHeightMode = .exact
        lynxView.translatesAutoresizingMaskIntoConstraints = false
        lynxView.addLifecycleClient(lifecycleClient)
        view.addSubview(lynxView)
        NSLayoutConstraint.activate([
            lynxView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            lynxView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            lynxView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            lynxView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
        ])
        self.lynxView = lynxView
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        guard let lynxView, lynxView.bounds.width > 0, lynxView.bounds.height > 0 else { return }
        lynxView.preferredLayoutWidth = lynxView.bounds.width
        lynxView.preferredLayoutHeight = lynxView.bounds.height
        if hasLoadedTemplate {
            lynxView.triggerLayout()
            return
        }
        hasLoadedTemplate = true

        guard let bundleURL = Bundle.main.url(forResource: "main", withExtension: "bundle"),
              let data = try? Data(contentsOf: bundleURL) else {
            RuntimeReporter.report("page_open_failed", detail: "main.bundle missing")
            return
        }
        RuntimeReporter.report("page_opened")
        lynxView.loadTemplate(data, withURL: "example://lynx/main")
    }

    deinit {
        lynxView?.clearForDestroy()
    }
}

private final class ExampleLynxLifecycleClient: NSObject, LynxViewLifecycle {
    func lynxViewDidFirstScreen(_ view: LynxView) {
        RuntimeReporter.report("page_ready")
    }

    func lynxView(_ view: LynxView, didRecieveError error: Error) {
        RuntimeReporter.report("page_open_failed", detail: error.localizedDescription)
    }
}
