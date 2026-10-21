table 50221 "BCD Mutation Fixture"
{
    DataClassification = CustomerContent;
    fields
    {
        field(1; "Run ID"; Guid) { }
        field(2; Name; Code[20]) { }
        field(3; Sequence; Integer) { }
        field(4; Quantity; Decimal)
        {
            InitValue = 1;
            trigger OnValidate()
            begin
                if Quantity < 0 then
                    Error('BCD_GENERIC_QUANTITY_NEGATIVE');
                Amount := Quantity * Price;
                Trace += 'Q';
            end;
        }
        field(5; Price; Decimal)
        {
            InitValue = 2;
            trigger OnValidate()
            begin
                Amount := Quantity * Price;
                Trace += 'P';
            end;
        }
        field(6; Amount; Decimal) { }
        field(7; Trace; Text[100]) { }
        field(8; "Insert Count"; Integer) { }
        field(9; "Modify Count"; Integer) { }
        field(10; Flag; Boolean) { }
        field(11; "Large Integer"; BigInteger) { }
        field(12; Description; Text[100])
        {
            trigger OnValidate()
            var
                Receipt: Record "BCD Mutation Receipt";
            begin
                if Description = 'BCD_MOVE_KEY' then
                    Name := 'B';
                if Description = 'BCD_COMMIT' then
                    Commit();
                if Description = 'BCD_IMPLICIT' then begin
                    if Codeunit.Run(Codeunit::"BCD Mutation Commit Body", Rec) then
                        Error('BCD_GENERIC_IMPLICIT_RETURNED');
                    Error('BCD_GENERIC_IMPLICIT_REJECTED: %1', GetLastErrorText());
                end;
                if Description = 'BCD_EXPIRE_RECEIPT' then begin
                    // Test-only clock fault, never a production scope timestamp input.
                    Receipt.Get(UserSecurityId(), "Scope Request");
                    Receipt."Retry Until" := CurrentDateTime() - 1000;
                    Receipt.Modify();
                end;
            end;
        }
        field(13; Identifier; Guid) { }
        field(14; "Date Value"; Date) { }
        field(15; "Time Value"; Time) { }
        field(16; "DateTime Value"; DateTime) { }
        field(17; Choice; Enum "Sales Line Type") { }
        field(18; "Option Value"; Option) { OptionMembers = None,First,Second; }
        field(19; Content; Blob) { }
        field(20; "Sequence Filter"; Integer) { FieldClass = FlowFilter; }
        field(21; "Entry Total"; Decimal)
        {
            FieldClass = FlowField;
            CalcFormula = sum("BCD Probe Sum Entry".Amount where("Run ID" = field("Run ID"), "Header Line No." = field("Sequence Filter")));
        }
        field(22; "Scope Request"; Guid) { }
        field(23; "Delay Milliseconds"; Integer) { }
    }
    keys { key(PK; "Run ID", Name, Sequence) { Clustered = true; } }

    trigger OnInsert()
    begin
        DelayForTest();
        "Insert Count" += 1;
        Trace += 'I';
        Log('I');
    end;

    trigger OnModify()
    begin
        DelayForTest();
        "Modify Count" += 1;
        Trace += 'M';
        Log('M');
    end;

    trigger OnDelete()
    begin
        DelayForTest();
        Log('D');
    end;

    trigger OnRename()
    begin
        DelayForTest();
        Log('R');
    end;

    local procedure DelayForTest()
    begin
        if ("Delay Milliseconds" < 0) or ("Delay Milliseconds" > 5000) then
            Error('BCD_COORD_DELAY');
        if "Delay Milliseconds" > 0 then
            Sleep("Delay Milliseconds");
    end;

    local procedure Log(Action: Code[1])
    var
        Entry: Record "BCD Mutation Trigger Log";
    begin
        Entry."Event ID" := CreateGuid();
        Entry."Run ID" := "Run ID";
        Entry.Action := Action;
        Entry.Insert();
    end;
}
