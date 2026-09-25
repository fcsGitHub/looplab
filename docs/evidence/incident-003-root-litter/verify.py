"""Verification: compute pi to 500 decimals via Chudnovsky (mpmath, 520-digit margin)
and cross-check with Machin formula and the known reference digits."""
import mpmath as mp

def chudnovsky(dps):
    mp.mp.dps = dps
    C = 426880 * mp.sqrt(10005)
    M, L, X, K, S = 1, 13591409, 1, 6, mp.mpf(13591409)
    for i in range(1, 60):
        M = (K**3 - 16*K) * M // (i**3)
        L += 545140134
        X *= -262537412640768000
        S += mp.mpf(M*L) / X
        K += 12
    return C / S

def machin(dps):
    mp.mp.dps = dps
    return 4*(4*mp.atan(1/mp.mpf(5)) - mp.atan(1/mp.mpf(239)))

REF = ("14159265358979323846264338327950288419716939937510"
"58209749445923078164062862089986280348253421170679"
"82148086513282306647093844609550582231725359408128"
"48111745028410270193852110555964462294895493038196"
"44288109756659334461284756482337867831652712019091"
"45648566923460348610454326648213393607260249141273"
"72458700660631558817488152092096282925409171536436"
"78925903600113305305488204665213841469519415116094"
"33057270365759591953092186117381932611793105118548"
"07446237996274956735188575272489122793818301194912")

c = mp.nstr(chudnovsky(520), 505).split('.')[1][:500]
m = mp.nstr(machin(520), 505).split('.')[1][:500]
print("Chudnovsky == reference (500 digits):", c == REF)
print("Machin      == reference (500 digits):", m == REF)
print("Chudnovsky == Machin    (500 digits):", c == m)
