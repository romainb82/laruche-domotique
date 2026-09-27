import SwiftUI
import DomoKit

/// L'accueil.
///
/// Les scènes d'abord — c'est le geste le plus fréquent — puis le résumé par
/// catégorie, puis les pièces.
struct HouseView: View {
    @Environment(HouseStore.self) private var store
    /// Le chemin de navigation est piloté par l'app : c'est ce qui permet
    /// d'ouvrir une pièce depuis un lien, un raccourci ou un widget.
    @State private var chemin: [String] = []

    var body: some View {
        NavigationStack(path: $chemin) {
            ScrollView {
                VStack(alignment: .leading, spacing: 26) {
                    entete
                    if !store.live { bandeauHorsLigne }
                    scenes
                    categories
                    plan
                    pieces
                }
                .padding(18)
            }
            .background(Theme.ground)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    HStack(spacing: 6) {
                        Circle().fill(store.live ? Theme.ok : Theme.crit).frame(width: 6, height: 6)
                            .accessibilityHidden(true)
                        Text(store.config?.house.name ?? "Maison")
                            .police(15, .semibold)
                    }
                    // Le point vert ou rouge était la seule trace de l'état du
                    // lien : portée par la couleur seule, donc invisible à qui
                    // ne la distingue pas.
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel(
                        "\(store.config?.house.name ?? "Maison"), \(store.live ? "connectée" : "hors ligne")"
                    )
                }
            }
            .refreshable { await store.charger() }
            .onChange(of: store.live) { _, live in
                AccessibilityNotification.Announcement(
                    live ? "Connexion rétablie" : (store.erreur ?? "Maison injoignable")
                ).post()
            }
            .task {
                // Ouverture directe sur une pièce, utile en développement et
                // pour les captures : `--args -zone z03` au lancement.
                guard let id = UserDefaults.standard.string(forKey: "zone") else { return }
                // La configuration arrive après le premier affichage : on
                // attend qu'elle soit là plutôt que d'abandonner tout de suite.
                for _ in 0..<40 {
                    if store.zone(id) != nil { chemin = [id]; return }
                    try? await Task.sleep(for: .milliseconds(250))
                }
            }
            .onOpenURL { url in
                // maison://zone/z03
                guard url.host() == "zone", let id = url.pathComponents.last,
                      store.zone(id) != nil else { return }
                chemin = [id]
            }
        }
    }

    // MARK: Morceaux

    private var entete: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                Text(salutation).etiquette()
                Text(resume)
                    .police(32, .semibold)
                    .foregroundStyle(Theme.ink)
                    .lineLimit(2)
                    .minimumScaleFactor(0.8)
                    // Repère stable pour l'audit d'accessibilité, qui mesure
                    // sur ce texte que la taille système est bien suivie.
                    .accessibilityIdentifier("resume-maison")
                Text(dateLongue).police(14).foregroundStyle(Theme.soft)
            }

            // Le contexte, discret mais toujours au même endroit. En gros
            // caractères la ligne ne tient plus : elle passe en colonne plutôt
            // que de couper « 11,2 » de son degré.
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 20) { mesuresContexte }
                VStack(alignment: .leading, spacing: 8) { mesuresContexte }
            }
        }
    }

    @ViewBuilder private var mesuresContexte: some View {
        ForEach(contexte, id: \.symbole) { c in
            HStack(spacing: 6) {
                Image(systemName: Icone.pour(c.symbole))
                    .police(14).foregroundStyle(Theme.faint)
                    .accessibilityHidden(true)
                Text(c.texte)
                    .police(16, .semibold, .monospaced)
                    .foregroundStyle(Theme.ink)
                    .lineLimit(1)
            }
        }
    }

    /// Extérieur et consommation : les deux chiffres qui situent la maison.
    private var contexte: [(symbole: String, texte: String)] {
        var out: [(String, String)] = []
        let mesure: (String) -> Double? = { id in
            guard let d = store.devices.first(where: { $0.id == id }), store.estJoignable(d.id)
            else { return nil }
            return store.state(d.id)?.measure?.value
        }
        if let t = mesure("z21.sensor.temperature") { out.append(("soleil", String(format: "%.1f°", t))) }
        if let w = mesure("z00.sensor.conso") { out.append(("eclair", "\(Int(w)) W")) }
        return out.map { (symbole: $0.0, texte: $0.1) }
    }

    private var bandeauHorsLigne: some View {
        HStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
            Text(store.erreur ?? "Maison injoignable — les états affichés ne sont plus à jour.")
                .police(14)
        }
        .foregroundStyle(Theme.crit)
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.crit.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    @ViewBuilder private var scenes: some View {
        if !store.scenes.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                Text("Scènes").etiquette()
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 12) {
                        ForEach(store.scenes) { SceneButton(scene: $0) }
                    }
                }
                .scrollClipDisabled()
            }
        }
    }

    private var categories: some View {
        let lampes = store.devices.filter(\.isLight)
        let volets = store.devices.filter { $0.type == .cover }
        let allumes = lampes.filter { store.state($0.id)?.isOn == true }
        let ouverts = volets.filter { (store.state($0.id)?.coverPosition ?? 0) > 5 }

        return LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 12) {
            CategoryCard(
                symbole: "lightbulb", valeur: "\(allumes.count)", sur: "/\(lampes.count)",
                titre: allumes.isEmpty ? "Éclairage" : "Tout éteindre", vive: !allumes.isEmpty
            ) {
                Task { await store.envoyer(.power(on: false), a: lampes.map(\.id)) }
            }

            CategoryCard(
                symbole: "blinds.horizontal.closed", valeur: "\(ouverts.count)", sur: "/\(volets.count)",
                titre: ouverts.count > volets.count / 2 ? "Fermer les volets" : "Ouvrir les volets",
                vive: false
            ) {
                let cible = ouverts.count > volets.count / 2 ? 0 : 100
                Task { await store.envoyer(.cover(position: cible), a: volets.map(\.id)) }
            }
        }
    }

    /// Le plan : la signature du projet, et ce qu'aucune autre app ne montre.
    private var plan: some View {
        VStack(spacing: 10) {
            HousePlanView { chemin = [$0] }
            Text("Touchez une pièce").etiquette()
        }
        .padding(14)
        .carte()
    }

    private var pieces: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Les pièces").etiquette()
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 12) {
                ForEach(store.zones.filter { !store.devices(dans: $0.id).isEmpty }) { zone in
                    NavigationLink(value: zone.id) { RoomCard(zone: zone) }
                        .buttonStyle(.plain)
                }
            }
        }
        .navigationDestination(for: String.self) { RoomView(zoneId: $0) }
    }

    // MARK: Textes

    private var salutation: String {
        switch Calendar.current.component(.hour, from: Date()) {
        case ..<6: "Bonne nuit"
        case ..<12: "Bonjour"
        case ..<18: "Bon après-midi"
        default: "Bonsoir"
        }
    }

    private var resume: String {
        let n = store.devices.filter(\.isLight).filter { store.state($0.id)?.isOn == true }.count
        return n == 0 ? "Tout est éteint" : "\(n) éclairage\(n > 1 ? "s" : "") allumé\(n > 1 ? "s" : "")"
    }

    private var dateLongue: String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "fr_FR")
        f.dateFormat = "EEEE d MMMM"
        return f.string(from: Date()).capitalized
    }
}

// MARK: - Éléments

private struct SceneButton: View {
    let scene: SceneConfig
    @Environment(HouseStore.self) private var store
    @State private var enCours = false
    /// La vignette s'élargit avec le texte : figée, elle tronquait les noms.
    @ScaledMetric(relativeTo: .body) private var largeur: CGFloat = 86

    var body: some View {
        Button {
            enCours = true
            Task {
                _ = await store.jouer(scene: scene)
                enCours = false
                AccessibilityNotification.Announcement("\(scene.label) activée").post()
            }
        } label: {
            VStack(spacing: 8) {
                Image(systemName: Icone.pour(scene.icon))
                    .police(19)
                    .frame(width: 44, height: 44)
                    .background(Theme.ink.opacity(0.06))
                    .foregroundStyle(enCours ? Theme.glowInk : Theme.soft)
                    .clipShape(Circle())
                Text(scene.label).police(12, .medium).lineLimit(1)
                    .foregroundStyle(Theme.ink)
            }
            .frame(width: largeur)
            .padding(.vertical, 14)
            .carte(enCours)
        }
        .buttonStyle(.plain)
        .disabled(enCours)
    }
}

private struct CategoryCard: View {
    let symbole: String, valeur: String, sur: String, titre: String, vive: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 6) {
                Image(systemName: symbole).police(18).foregroundStyle(Theme.soft)
                HStack(alignment: .firstTextBaseline, spacing: 1) {
                    Text(valeur).police(24, .semibold, .monospaced)
                    Text(sur).police(14).foregroundStyle(Theme.faint)
                }
                Text(titre).etiquette()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
            .carte(vive)
        }
        .buttonStyle(.plain)
    }
}

private struct RoomCard: View {
    let zone: Zone
    @Environment(HouseStore.self) private var store

    var body: some View {
        let equipements = store.devices(dans: zone.id)
        let lampes = equipements.filter(\.isLight)
        let allumes = lampes.filter { store.state($0.id)?.isOn == true }.count
        let temperature = equipements
            .first { $0.metric == .temperature }
            .flatMap { store.estJoignable($0.id) ? store.state($0.id)?.measure?.value : nil }

        return VStack(alignment: .leading, spacing: 10) {
            HStack {
                Image(systemName: allumes > 0 ? "lightbulb.fill" : "lightbulb")
                    .police(16)
                    .frame(width: 38, height: 38)
                    .background(allumes > 0 ? Theme.glow : Theme.ink.opacity(0.06))
                    .foregroundStyle(allumes > 0 ? Theme.surface : Theme.faint)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                Spacer()
                if let t = temperature {
                    Text(String(format: "%.1f°", t))
                        .police(17, .semibold, .monospaced)
                }
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(zone.label).police(15, .semibold).lineLimit(1)
                Text(allumes > 0 ? "\(allumes) / \(lampes.count) allumés" : "\(equipements.count) équipements")
                    .etiquette()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .carte(allumes > 0)
    }
}
