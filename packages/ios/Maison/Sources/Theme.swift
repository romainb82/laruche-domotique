import SwiftUI

/// L'identité visuelle, reprise du web.
///
/// Neutres chauds : une maison n'est pas une application de bureau : l'ambre
/// pour la lumière allumée, un bleu froid pour le jour qui entre par les
/// volets. Thème clair assumé, pas subi.
enum Theme {
    static let ground = Color(red: 0.980, green: 0.969, blue: 0.953)
    static let surface = Color.white
    static let raised  = Color(red: 0.957, green: 0.941, blue: 0.918)
    static let line    = Color(red: 0.886, green: 0.859, blue: 0.824)
    static let ink     = Color(red: 0.110, green: 0.094, blue: 0.082)
    static let soft    = Color(red: 0.455, green: 0.424, blue: 0.392)
    /// Relevé à 2,51:1 sur le fond papier : très en dessous des 4,5:1 exigés.
    /// Cette teinte porte toutes les étiquettes en capitales de l'interface.
    static let faint   = Color(red: 0.447, green: 0.424, blue: 0.400)

    /// La lumière allumée. Tout le vocabulaire visuel tourne autour.
    /// Reste telle quelle : un aplat décoratif n'a besoin que de 3:1.
    static let glow     = Color(red: 0.784, green: 0.471, blue: 0.098)
    /// La même ambre, assombrie pour le TEXTE : la version claire plafonne à
    /// 3,00:1, insuffisant sous 18 pt. Celle-ci est à 5,41:1.
    static let glowInk  = Color(red: 0.588, green: 0.337, blue: 0.047)
    /// Le jour qui entre : volets, ouvrants, position.
    static let jour     = Color(red: 0.290, green: 0.494, blue: 0.651)
    /// Idem pour le bleu porté par du texte.
    static let jourInk  = Color(red: 0.263, green: 0.443, blue: 0.584)

    static let ok   = Color(red: 0.173, green: 0.431, blue: 0.322)
    static let warn = Color(red: 0.569, green: 0.400, blue: 0.031)
    static let crit = Color(red: 0.659, green: 0.220, blue: 0.173)

    static let rayon: CGFloat = 22
}

/// Une police à taille choisie, qui suit malgré tout les réglages d'accessibilité.
///
/// `.font(.system(size:))` est FIGÉ : il ignore totalement le curseur de taille
/// de texte d'iOS. Or ce réglage est, de loin, le plus utilisé : bien avant
/// VoiceOver. Les styles sémantiques (`.body`, `.caption`) scalent mais
/// imposent leurs tailles, ce qui casserait des proportions réglées au point.
///
/// `@ScaledMetric` donne le meilleur des deux : on garde la taille voulue, et
/// elle grandit du même facteur que le corps de texte système.
private struct PoliceEchelle: ViewModifier {
    @ScaledMetric(relativeTo: .body) private var facteur: CGFloat = 100
    let taille: CGFloat
    let poids: Font.Weight
    let design: Font.Design

    func body(content: Content) -> some View {
        content.font(.system(size: taille * facteur / 100, weight: poids, design: design))
    }
}

extension View {
    /// Remplace `.font(.system(size:weight:design:))`, qui ne scale pas.
    func police(_ taille: CGFloat, _ poids: Font.Weight = .regular,
                _ design: Font.Design = .default) -> some View {
        modifier(PoliceEchelle(taille: taille, poids: poids, design: design))
    }
}

extension View {
    /// L'étiquette en petites capitales espacées, comme sur le web.
    func etiquette() -> some View {
        self.police(10, .medium, .monospaced)
            .tracking(1.4)
            .textCase(.uppercase)
            .foregroundStyle(Theme.faint)
    }

    func carte(_ actif: Bool = false) -> some View {
        self.background(actif ? Theme.glow.opacity(0.09) : Theme.surface)
            .clipShape(RoundedRectangle(cornerRadius: Theme.rayon, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: Theme.rayon, style: .continuous)
                    .strokeBorder(actif ? Theme.glow.opacity(0.45) : Theme.line, lineWidth: 1)
            )
    }
}

/// Le jeu d'icônes, aligné sur celui du web.
enum Icone {
    static func pour(_ nom: String) -> String {
        switch nom {
        case "soleil": "sun.max"
        case "lune": "moon"
        case "porte": "door.left.hand.open"
        case "ampoule": "lightbulb"
        case "volet": "blinds.horizontal.closed"
        case "piscine": "drop.circle"
        case "eclair": "bolt"
        case "thermo": "thermometer.medium"
        case "goutte": "humidity"
        default: "house"
        }
    }
}
