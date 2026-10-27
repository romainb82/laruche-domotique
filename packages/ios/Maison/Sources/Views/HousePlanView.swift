import SwiftUI
import DomoKit

/// Le plan de la maison.
///
/// La signature du projet, et ce qu'aucune app de domotique ne montre. Il dit
/// deux choses d'un seul coup d'œil, sans un mot à lire :
///   · une pièce allumée rayonne en ambre ;
///   · chaque ouvrant porte son volet, dessiné à sa position réelle.
///
/// Toute la géométrie vient du serveur : `Zone.plan` et `Device.opening`, donc
/// redécouper une pièce se fait dans le paramétrage, pas ici.
struct HousePlanView: View {
    @Environment(HouseStore.self) private var store
    let onSelect: (String) -> Void

    /// Le texte dessiné suit la taille système, mais borné : un plan dont les
    /// noms débordent des pièces n'est plus un plan. Au-delà de cette borne,
    /// c'est la liste des pièces, juste en dessous, qui prend le relais, et
    /// VoiceOver lit de toute façon chaque pièce en entier.
    @ScaledMetric(relativeTo: .body) private var facteurTexte: CGFloat = 100
    private var echelleTexte: CGFloat { Swift.min(1.8, facteurTexte / 100) }

    /// Le repère du plan, cadré sur les murs plutôt que sur la zone de saisie :
    /// sans ça le dessin flotte au milieu d'une marge vide.
    /// Relevé sur le plan du diagnostic d'avril 2026 : la maison s'élargit à
    /// l'est au niveau de la chambre 4, et la buanderie descend plus bas que le
    /// reste au sud-ouest. L'ancien tracé ignorait ce second décrochement.
    private let cadre = CGRect(x: 22, y: 22, width: 601, height: 295)

    /// L'enveloppe, avec son décrochement à l'est.
    private static let contour: [CGPoint] = [
        .init(x: 30, y: 30), .init(x: 590, y: 30), .init(x: 590, y: 173),
        .init(x: 615, y: 173), .init(x: 615, y: 287), .init(x: 132, y: 287),
        .init(x: 132, y: 309), .init(x: 30, y: 309),
    ]

    var body: some View {
        GeometryReader { geo in
            let k = geo.size.width / cadre.width
            let dessin = CGSize(width: geo.size.width, height: cadre.height * k)

            ZStack(alignment: .topLeading) {
                Canvas { ctx, _ in
                    ctx.scaleBy(x: k, y: k)
                    ctx.translateBy(x: -cadre.minX, y: -cadre.minY)

                    dessinerHalos(ctx)
                    dessinerPieces(ctx)
                    dessinerMurs(ctx)
                    dessinerVolets(ctx)
                }
                .frame(height: dessin.height)

                // Les zones tactiles sont des vues, pas du Canvas : le dessin
                // ne sait pas recevoir un toucher par pièce.
                ForEach(piecesSurPlan, id: \.zone.id) { p in
                    ForEach(Array((p.zone.plan ?? []).enumerated()), id: \.offset) { i, r in
                        // La zone tactile épouse exactement la pièce dessinée.
                        //
                        // Un essai précédent l'élargissait à 44 pt minimum pour
                        // satisfaire la règle des cibles : les petites pièces
                        // se chevauchaient alors, et le centre de la Buanderie
                        // se retrouvait couvert par sa voisine : un toucher au
                        // milieu d'une pièce ouvrait l'autre. Une cible plus
                        // grande qui désigne la mauvaise pièce ne vaut rien.
                        //
                        // La règle est tenue autrement : la liste des pièces,
                        // juste en dessous, offre la même action en pleine
                        // taille pour chacune. Le plan est un raccourci, pas
                        // le seul chemin.
                        Rectangle()
                            .fill(.clear)
                            .contentShape(Rectangle())
                            .frame(width: r.w * k, height: r.h * k)
                            .offset(x: (r.x - cadre.minX) * k, y: (r.y - cadre.minY) * k)
                            .onTapGesture { onSelect(p.zone.id) }
                            // Un rectangle vide n'entre pas de lui-même dans
                            // l'arbre d'accessibilité, et un onTapGesture n'est
                            // pas une action VoiceOver : il faut dire les deux.
                            .accessibilityElement()
                            .accessibilityLabel(etiquette(p))
                            .accessibilityAddTraits(.isButton)
                            .accessibilityAction { onSelect(p.zone.id) }
                            .accessibilityIdentifier("plan-piece")
                            .accessibilityHidden(i > 0)   // une pièce, une entrée
                    }
                }
            }
            .frame(height: dessin.height)
        }
        .aspectRatio(cadre.width / cadre.height, contentMode: .fit)
    }

    // MARK: Données

    private struct Piece {
        let zone: Zone
        let allumes: Int
        let eclat: Double        // 0–1, pilote l'intensité de la lueur
        let temperature: Double?
        let principal: PlanRect  // le plus grand rectangle porte l'étiquette
    }

    private var piecesSurPlan: [Piece] {
        store.zones.compactMap { zone in
            guard let rects = zone.plan, !rects.isEmpty else { return nil }
            let equipements = store.devices(dans: zone.id)
            let lampes = equipements.filter(\.isLight)
            let on = lampes.filter { store.state($0.id)?.isOn == true }
            let eclat = lampes.isEmpty ? 0
                : on.reduce(0.0) { $0 + (store.state($1.id)?.level ?? 100) / 100 } / Double(lampes.count)

            let t = equipements.first { $0.metric == .temperature }
                .flatMap { store.estJoignable($0.id) ? store.state($0.id)?.measure?.value : nil }

            return Piece(
                zone: zone, allumes: on.count, eclat: Swift.min(1, eclat), temperature: t,
                principal: rects.max { $0.w * $0.h < $1.w * $1.h }!
            )
        }
    }

    private var volets: [(o: PlanOpening, zoneId: String, position: Double, bouge: Bool)] {
        store.devices.compactMap { d in
            guard let o = d.opening, d.type == .cover else { return nil }
            let e = store.state(d.id)
            return (o, d.zoneId, e?.coverPosition ?? 0, e?.coverMoving != nil)
        }
    }

    // MARK: Dessin

    /// La lueur diffuse sous les pièces allumées : posée avant tout le reste.
    private func dessinerHalos(_ ctx: GraphicsContext) {
        var flou = ctx
        flou.addFilter(.blur(radius: 9))
        for p in piecesSurPlan where p.allumes > 0 {
            for r in p.zone.plan ?? [] {
                flou.fill(
                    Path(CGRect(x: r.x, y: r.y, width: r.w, height: r.h)),
                    with: .color(Theme.glow.opacity(0.16 + p.eclat * 0.30))
                )
            }
        }
    }

    private func dessinerPieces(_ ctx: GraphicsContext) {
        for p in piecesSurPlan {
            let allumee = p.allumes > 0
            for r in p.zone.plan ?? [] {
                let chemin = Path(roundedRect: CGRect(x: r.x, y: r.y, width: r.w, height: r.h),
                                  cornerRadius: 3)
                ctx.fill(chemin, with: .color(allumee
                    ? Theme.glow.opacity(0.16 + p.eclat * 0.20)
                    : Theme.ink.opacity(0.045)))
                ctx.stroke(chemin,
                           with: .color(allumee ? Theme.glow.opacity(0.75) : Theme.ink.opacity(0.22)),
                           lineWidth: allumee ? 1.6 : 1)
            }

            let cx = p.principal.x + p.principal.w / 2
            let cy = p.principal.y + p.principal.h / 2
            // Une pièce étroite ne porte pas le même corps de texte qu'un salon.
            let base: CGFloat = p.principal.w < 55 ? 8 : p.principal.w < 80 ? 9.5 : 11
            let corps = base * echelleTexte
            let place = p.principal.h >= 45

            ctx.draw(
                Text(p.zone.label)
                    .font(.system(size: corps, weight: .semibold))
                    .foregroundStyle(allumee ? Theme.glowInk : Theme.ink),
                at: CGPoint(x: cx, y: place && p.temperature != nil ? cy - 5 : cy)
            )
            if let t = p.temperature, place {
                ctx.draw(
                    Text(String(format: "%.1f°", t))
                        .font(.system(size: corps - 2).monospacedDigit())
                        .foregroundStyle(Theme.soft),
                    at: CGPoint(x: cx, y: cy + 7)
                )
            }
        }
    }

    private func dessinerMurs(_ ctx: GraphicsContext) {
        var p = Path()
        p.addLines(Self.contour)
        p.closeSubpath()
        ctx.stroke(p, with: .color(Theme.ink.opacity(0.55)),
                   style: .init(lineWidth: 3, lineJoin: .round))
    }

    /// Le tablier s'efface à mesure que le volet s'ouvre : plein = fermé.
    private func dessinerVolets(_ ctx: GraphicsContext) {
        for v in volets {
            let a = CGPoint(x: v.o.x1, y: v.o.y1)
            let b = CGPoint(x: v.o.x2, y: v.o.y2)

            var ouvrant = Path()
            ouvrant.move(to: a); ouvrant.addLine(to: b)
            ctx.stroke(ouvrant, with: .color(Theme.ground), style: .init(lineWidth: 6))
            ctx.stroke(ouvrant, with: .color(Theme.jour.opacity(0.25)), style: .init(lineWidth: 5))

            let f = 1 - v.position / 100
            guard f > 0.01 else { continue }
            var tablier = Path()
            tablier.move(to: a)
            tablier.addLine(to: CGPoint(x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f))
            ctx.stroke(tablier,
                       with: .color(Theme.jour.opacity(v.bouge ? 0.55 : 1)),
                       style: .init(lineWidth: 5))
        }
    }

    private func etiquette(_ p: Piece) -> String {
        var t = p.zone.label
        if p.allumes > 0 { t += ", \(p.allumes) allumé" }
        if let v = p.temperature { t += String(format: ", %.1f degrés", v) }
        // Le tablier est dessiné dans le Canvas, que VoiceOver ne lit pas :
        // sans cette ligne, la position des volets n'existe pas au plan.
        let miens = volets.filter { $0.zoneId == p.zone.id }
        if !miens.isEmpty {
            let moyenne = Int((miens.map(\.position).reduce(0, +) / Double(miens.count)).rounded())
            t += moyenne == 0 ? ", volets fermés"
               : moyenne == 100 ? ", volets ouverts"
               : ", volets à \(moyenne) %"
        }
        return t
    }
}
