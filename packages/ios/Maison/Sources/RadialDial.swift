import SwiftUI

/// L'arc de réglage.
///
/// Un cadran ouvert vers le bas : le vide en bas porte les bornes, donc
/// l'échelle se lit sans graduation. 270° de course : plus précis qu'un
/// curseur linéaire sur la même surface.
///
/// Le tracé passe par des `Shape`, qui reçoivent leur rectangle et se calculent
/// seules. Une version précédente utilisait un `GeometryReader` : gourmand par
/// nature, il réclamait toute la hauteur offerte et la carte finissait deux
/// fois trop haute, chiffres flottants.
struct RadialDial: View {
    let valeur: Double
    let min: Double
    let max: Double
    let texte: String
    var unite: String = ""
    var legende: String = ""
    var pas: Double = 0.5
    var teinte: Color = Theme.glow
    var desactive: Bool = false
    /// Suit le doigt : ne sert qu'à dessiner l'aperçu.
    var onApercu: (Double) -> Void = { _ in }
    /// Part UNE fois, au relâché (ou sur ±) : c'est lui qui commande la maison.
    /// Avant, chaque mouvement du doigt envoyait une commande : des dizaines
    /// de requêtes par seconde vers un Modbus ou un broker.
    let onChange: (Double) -> Void
    @State private var derniere: Double?

    /// Taille du cadran. Fixe et modeste : sur un téléphone, la place gagnée
    /// profite aux équipements en dessous.
    private let taille: CGFloat = 172
    private let epaisseur: CGFloat = 13

    private static let depart = 135.0
    private static let course = 270.0

    private var fraction: Double {
        let f = (valeur - min) / (max - min)
        return Swift.min(1, Swift.max(0, f.isFinite ? f : 0))
    }

    var body: some View {
        HStack(spacing: 14) {
            bouton("minus", "Diminuer") { pousser(-pas) }

            ZStack {
                ArcPiste(fraction: 1, epaisseur: epaisseur)
                    .stroke(Theme.ink.opacity(0.08), style: .init(lineWidth: epaisseur, lineCap: .round))

                ArcPiste(fraction: Swift.max(0.001, fraction), epaisseur: epaisseur)
                    .stroke(teinte, style: .init(lineWidth: epaisseur, lineCap: .round))
                    .animation(.spring(duration: 0.3), value: fraction)

                Poignee(fraction: fraction, epaisseur: epaisseur)
                    .animation(.spring(duration: 0.3), value: fraction)

                VStack(spacing: 5) {
                    HStack(alignment: .firstTextBaseline, spacing: 2) {
                        Text(texte)
                            .police(36, .semibold, .monospaced)
                            .monospacedDigit()
                        if !unite.isEmpty {
                            Text(unite).police(16).foregroundStyle(Theme.soft)
                        }
                    }
                    if !legende.isEmpty {
                        Text(legende).etiquette().lineLimit(1)
                    }
                }
                .padding(.horizontal, 12)
                .allowsHitTesting(false)

                // Les bornes se logent dans l'ouverture du bas.
                VStack {
                    Spacer()
                    HStack {
                        Text(nombre(min)); Spacer(); Text(nombre(max))
                    }
                    .police(10, .regular, .monospaced)
                    .foregroundStyle(Theme.faint)
                }
                .padding(.horizontal, 20)
                .allowsHitTesting(false)
            }
            .frame(width: taille, height: taille)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { g in
                        guard !desactive else { return }
                        if let v = valeur(depuis: g.location), v != derniere {
                            derniere = v
                            onApercu(v)
                        }
                    }
                    .onEnded { _ in
                        guard !desactive, let v = derniere else { return }
                        derniere = nil
                        onChange(v)
                    }
            )
            .opacity(desactive ? 0.45 : 1)
            // Le cadran se balayait en quatre ou cinq arrêts séparés : « 21,5 »,
            // « degrés », « 14 », « 24 », sans qu'aucun ne puisse le régler :
            // le geste circulaire est capté par le rotor de VoiceOver.
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(legende.isEmpty ? "Réglage" : legende)
            .accessibilityValue("\(texte)\(unite.isEmpty ? "" : " \(unite)")")
            .accessibilityAdjustableAction { sens in
                guard !desactive else { return }
                pousser(sens == .increment ? pas : -pas)
            }

            bouton("plus", "Augmenter") { pousser(pas) }
        }
    }

    // MARK: Contrôles

    private func bouton(_ symbole: String, _ libelle: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbole)
                .police(17, .light)
                .frame(width: 46, height: 46)
                .background(Theme.ink.opacity(0.06))
                .foregroundStyle(Theme.ink)
                .clipShape(RoundedRectangle(cornerRadius: 15, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(desactive)
        .opacity(desactive ? 0.35 : 1)
        // Un « moins » nu ne dit pas de quoi : plusieurs cadrans se suivent.
        .accessibilityLabel("\(libelle)\(legende.isEmpty ? "" : " : \(legende)")")
    }

    private func pousser(_ delta: Double) {
        guard !desactive else { return }
        let v = Swift.min(max, Swift.max(min, valeur + delta))
        if v != valeur { onChange(v) }
    }

    /// Position du doigt → valeur. Le vide du bas est une zone morte, pas un saut.
    private func valeur(depuis p: CGPoint) -> Double? {
        let centre = CGPoint(x: taille / 2, y: taille / 2)
        var deg = atan2(p.y - centre.y, p.x - centre.x) * 180 / .pi
        if deg < 0 { deg += 360 }
        if deg < Self.depart - 45 { deg += 360 }
        deg = Swift.min(Self.depart + Self.course, Swift.max(Self.depart, deg))
        let brut = min + (deg - Self.depart) / Self.course * (max - min)
        return (brut / pas).rounded() * pas
    }

    private func nombre(_ v: Double) -> String {
        v == v.rounded() ? String(Int(v)) : String(format: "%.1f", v)
    }
}

// MARK: - Formes

/// L'arc, du départ jusqu'à la fraction demandée.
private struct ArcPiste: Shape {
    var fraction: Double
    let epaisseur: CGFloat

    var animatableData: Double {
        get { fraction }
        set { fraction = newValue }
    }

    func path(in rect: CGRect) -> Path {
        let centre = CGPoint(x: rect.midX, y: rect.midY)
        let rayon = Swift.min(rect.width, rect.height) / 2 - epaisseur / 2 - 2
        var p = Path()
        p.addArc(center: centre, radius: rayon,
                 startAngle: .degrees(135),
                 endAngle: .degrees(135 + 270 * fraction),
                 clockwise: false)
        return p
    }
}

/// La poignée, qui dit que ça se tourne.
private struct Poignee: View {
    let fraction: Double
    let epaisseur: CGFloat

    var body: some View {
        GeometryReader { geo in
            let rayon = Swift.min(geo.size.width, geo.size.height) / 2 - epaisseur / 2 - 2
            let a = (135 + 270 * fraction) * .pi / 180
            Circle()
                .fill(Theme.surface)
                .overlay(Circle().strokeBorder(Theme.glow, lineWidth: 3))
                .frame(width: 18, height: 18)
                .position(
                    x: geo.size.width / 2 + rayon * cos(a),
                    y: geo.size.height / 2 + rayon * sin(a)
                )
        }
    }
}
