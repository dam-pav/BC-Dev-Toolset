codeunit 50212 "BCD Commit Probe"
{
    TableNo = "BCD Probe Header";

    trigger OnRun()
    begin
        // Reserved fixture rows only; no web-service registration or elevated rights.
        Rec.Insert();
        if Rec."Probe Text" = 'explicit' then
            Commit();
    end;
}
